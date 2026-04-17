// Vercel Serverless Function: AI Policy Analysis
// This function is called from the admin panel to analyze uploaded policy documents.
// It uses the Anthropic Claude API to review documents and generate findings.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { audit_id } = req.body;
  if (!audit_id) {
    return res.status(400).json({ error: 'Missing audit_id' });
  }

  // Environment variables (set in Vercel dashboard)
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use service key for server-side
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server configuration error. Check environment variables.' });
  }

  try {
    // 1. Fetch audit data from Supabase
    const auditRes = await fetch(`${SUPABASE_URL}/rest/v1/audits?id=eq.${audit_id}&select=*`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });
    const audits = await auditRes.json();
    if (!audits || audits.length === 0) {
      return res.status(404).json({ error: 'Audit not found' });
    }
    const audit = audits[0];

    // 2. Fetch questionnaire responses
    const qRes = await fetch(`${SUPABASE_URL}/rest/v1/questionnaire_responses?audit_id=eq.${audit_id}&select=*`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });
    const qData = await qRes.json();
    const questionnaire = qData?.[0]?.responses || {};

    // 3. Fetch document list
    const docsRes = await fetch(`${SUPABASE_URL}/rest/v1/documents?audit_id=eq.${audit_id}&select=*`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });
    const documents = await docsRes.json();

    // 4. For image documents, get their URLs for Claude's vision capability
    const imageDocuments = documents.filter(d =>
      d.file_name?.match(/\.(jpg|jpeg|png|tiff|tif)$/i)
    );

    // Build content blocks for Claude (text + images)
    const contentBlocks = [];

    // Add text context
    contentBlocks.push({
      type: 'text',
      text: buildAnalysisPrompt(audit, questionnaire, documents)
    });

    // Add image documents for vision analysis
    for (const doc of imageDocuments.slice(0, 5)) { // Limit to 5 images
      try {
        const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/policy-documents/${doc.file_path}`;
        const imageRes = await fetch(imageUrl);
        if (imageRes.ok) {
          const buffer = await imageRes.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');
          const mediaType = doc.file_name.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
          contentBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          });
          contentBlocks.push({
            type: 'text',
            text: `The above image is document "${doc.file_name}" (Document ID: ${doc.id}). Analyze it carefully for any errors, inconsistencies, or coverage gaps.`
          });
        }
      } catch (e) {
        console.error('Failed to fetch image:', doc.file_name, e.message);
      }
    }

    // 5. Call Claude API
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: contentBlocks
        }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude API error:', errText);
      return res.status(500).json({ error: 'AI analysis failed: ' + claudeRes.status });
    }

    const claudeData = await claudeRes.json();
    const analysisText = claudeData.content?.[0]?.text || '';

    // 6. Parse Claude's response into structured findings
    const findings = parseFindings(analysisText);

    // 7. Save findings to Supabase
    if (findings.length > 0) {
      // Delete existing AI-generated findings first
      await fetch(`${SUPABASE_URL}/rest/v1/findings?audit_id=eq.${audit_id}&source=eq.ai`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      });

      // Insert new findings
      const findingsToInsert = findings.map(f => ({
        audit_id: audit_id,
        title: f.title,
        description: f.description,
        why_it_matters: f.why_it_matters,
        agent_language: f.agent_language,
        severity: f.severity,
        estimated_impact: f.estimated_impact || 0,
        document_id: f.document_id || null,
        highlight_coords: f.highlight_coords || null,
        source: 'ai',
        created_at: new Date().toISOString()
      }));

      await fetch(`${SUPABASE_URL}/rest/v1/findings`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(findingsToInsert)
      });
    }

    // 8. Update audit status
    await fetch(`${SUPABASE_URL}/rest/v1/audits?id=eq.${audit_id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        status: 'admin_review',
        ai_analysis_at: new Date().toISOString(),
        ai_raw_response: analysisText.substring(0, 10000) // Store raw response for reference
      })
    });

    return res.status(200).json({
      success: true,
      findings_count: findings.length,
      message: `Analysis complete. ${findings.length} findings generated.`
    });

  } catch (err) {
    console.error('Analysis error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function buildAnalysisPrompt(audit, questionnaire, documents) {
  return `You are a highly skilled, independent crop insurance underwriter conducting a policy audit for a commercial farmer. Your job is to analyze their crop insurance policy documents and questionnaire responses to find errors, coverage gaps, and savings opportunities.

FARM INFORMATION:
- Farm Name: ${audit.farm_name || 'Unknown'}
- State: ${audit.state || 'Unknown'}
- County: ${audit.county || 'Unknown'}
- Total Acres: ${audit.acres || 'Unknown'}
- Crops: ${audit.crops || 'Unknown'}

QUESTIONNAIRE RESPONSES:
${JSON.stringify(questionnaire, null, 2)}

DOCUMENTS PROVIDED:
${documents.map(d => `- ${d.file_name} (${d.file_type}, ${(d.file_size / 1024).toFixed(1)} KB)`).join('\n')}

INSTRUCTIONS:
1. Analyze all provided documents carefully. Look at every number, code, date, and coverage detail.
2. Cross-reference the farmer's questionnaire answers with what you see in the documents.
3. Identify ALL of the following issues if present:

COMMON ERRORS TO CHECK:
- Practice code mismatches (irrigated vs non-irrigated, following another crop)
- Incorrect acreage reporting
- Wrong coverage level for the operation size
- Suboptimal unit structure (basic vs optional vs enterprise)
- Missing or incorrect endorsements
- APH yield reporting errors or missing yield exclusion
- Prevented planting provisions that should be modified
- Missing SCO/ECO coverage that could benefit the operation
- Premium overcharges based on incorrect data
- Crops mentioned by farmer but not on the policy
- Outdated endorsements that no longer apply

4. For each finding, provide:
- A clear title
- A detailed description of the issue
- Why it matters (what happens if not fixed)
- Exact language the farmer should use when talking to their agent
- Estimated dollar impact (conservative estimate)
- Severity: "critical" (definite error or significant gap), "warning" (potential issue worth investigating), or "ok" (informational)

5. If you can identify the location of an error in a document image, provide approximate coordinates as percentages (top, left, width, height) for highlighting.

CRITICAL RULES:
- Only report findings you are confident about based on the evidence provided.
- Do NOT hallucinate or fabricate issues. If you're unsure, mark it as "warning" severity and note the uncertainty.
- Be specific with dollar estimates. Use conservative numbers based on typical rates for the state/county.
- Write in plain English that a farmer without insurance expertise can understand.

FORMAT YOUR RESPONSE AS JSON:
{
  "findings": [
    {
      "title": "string",
      "description": "string",
      "why_it_matters": "string",
      "agent_language": "string",
      "severity": "critical|warning|ok",
      "estimated_impact": number,
      "document_id": "string or null",
      "highlight_coords": { "top": number, "left": number, "width": number, "height": number } or null
    }
  ],
  "executive_summary": "string - 2-3 paragraph summary of overall findings"
}`;
}

function parseFindings(responseText) {
  try {
    // Try to extract JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*"findings"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.findings || [];
    }
  } catch (e) {
    console.error('Failed to parse AI response as JSON:', e.message);
  }

  // Fallback: create a single finding with the raw text
  return [{
    title: 'AI Analysis Results',
    description: responseText.substring(0, 1000),
    why_it_matters: 'Review the full analysis and extract specific findings manually.',
    agent_language: '',
    severity: 'warning',
    estimated_impact: 0
  }];
}
