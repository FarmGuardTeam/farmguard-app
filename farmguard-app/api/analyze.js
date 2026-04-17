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

    // 6. Parse Claude's response into structured findings + executive summary
    const { findings, executiveSummary } = parseAnalysisResponse(analysisText);

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
        ai_raw_response: analysisText.substring(0, 10000),
        executive_summary: executiveSummary || null,
        savings_found: findings.reduce((sum, f) => sum + (f.estimated_impact || 0), 0)
      })
    });

    const totalImpact = findings.reduce((sum, f) => sum + (f.estimated_impact || 0), 0);
    return res.status(200).json({
      success: true,
      findings_count: findings.length,
      total_impact: totalImpact,
      has_summary: !!executiveSummary,
      message: `Analysis complete. ${findings.length} findings generated. Estimated total impact: $${totalImpact.toLocaleString()}.`
    });

  } catch (err) {
    console.error('Analysis error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function buildAnalysisPrompt(audit, questionnaire, documents) {
  return `You are a highly skilled, independent crop insurance underwriter with 20+ years of experience. You are conducting a comprehensive policy audit for a commercial farmer. You work for FarmGuard, an independent audit service — you do NOT sell insurance and you earn NO commissions. Your only job is to protect the farmer's interests.

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

====================================================================
COMPREHENSIVE AUDIT INSTRUCTIONS
====================================================================

Perform an exhaustive, line-by-line review of every document provided. This farmer is paying for a professional audit and expects thorough, actionable results.

STEP 1: EXTRACT ALL POLICY DATA
Read every document carefully and extract:
- AIP (Approved Insurance Provider) name and agent name
- Policy number and crop year
- Plan of insurance for each crop (RP, RP-HPE, YP, ARP, etc.)
- Coverage level percentage for each crop
- Unit structure (Basic, Optional, Enterprise) for each crop
- Each crop insured: acres, practice code, type, county, coverage level
- Premium amounts (total and per-crop if visible)
- Any endorsements or riders
- APH yields if provided
- Prevented planting elections
- SCO/ECO elections
- Any other relevant policy details

STEP 2: CROSS-REFERENCE WITH QUESTIONNAIRE
Compare what the farmer told us against what the documents show:
- Do the crops match what they said they grow?
- Do the acres match?
- Do the practice codes match their actual farming practices (irrigated vs dryland)?
- Did they mention double-cropping but the policy doesn't reflect it?
- Did they express concerns that the documents confirm?

STEP 3: COMPREHENSIVE ERROR AND GAP ANALYSIS
Check EVERY one of these items. For each, explain what you found:

A. COVERAGE LEVEL ANALYSIS
- Is the coverage level optimal for this operation size?
- Run the cost/benefit: what does moving up or down 5% in coverage cost vs. the additional protection?
- Calculate the actual dollar difference in coverage at different levels
- Example: "At 75% coverage on 800 acres of corn at $5.50 projected price with 180 bu APH, your guarantee is $594,000. Moving to 80% would increase your guarantee to $633,600 — an additional $39,600 in protection for approximately $X more in premium."

B. UNIT STRUCTURE ANALYSIS
- Is Enterprise, Optional, or Basic the right choice?
- Calculate the premium savings of Enterprise vs Optional units
- Calculate the trade-off: what claim scenarios would pay more under Optional vs Enterprise?
- For larger operations (1000+ acres), Enterprise units almost always save money — flag if they're not using them
- Example: "Switching from Optional to Enterprise units on your corn would save approximately $X in premium. The trade-off is that losses are averaged across all your corn acres rather than calculated per unit."

C. PRACTICE CODE VERIFICATION
- Does every practice code match the farmer's actual farming method?
- Irrigated acres coded as non-irrigated (or vice versa) — this is one of the most costly errors
- Following another crop (double-crop) practice codes
- Calculate the premium and coverage impact of any mismatches

D. PLAN OF INSURANCE REVIEW
- Is RP the right choice, or would RP-HPE or YP be better for this operation?
- If they have RP-HPE, are they aware they lose the harvest price protection?
- Calculate the premium difference between plans
- Example: "You're currently on RP-HPE which saved you $X in premium, but you gave up harvest price protection. In a year where harvest price exceeds projected price (happened 3 of the last 10 years for corn), you could miss out on $X in additional coverage."

E. SUPPLEMENTAL COVERAGE (SCO/ECO)
- Should they add SCO? Calculate the premium cost vs additional coverage band
- Should they add ECO? Same analysis
- If they have SCO/ECO, is it the right coverage band?
- Note: SCO cannot be used with Enterprise units in some configurations

F. APH RECORD REVIEW (if records provided)
- Compare reported yields to county averages from NASS data
- Look for years with unusually low yields that might be errors
- Check for "plug yields" (T-yields) where actual data should exist
- Is Yield Exclusion (YE) being applied? Is the county eligible?
- Calculate how much higher the APH could be with corrections
- Example: "Your 2019 corn yield of 95 bu/acre is significantly below your 10-year average of 178. If this was a prevented planting year that wasn't reported correctly, fixing it could raise your APH by X bushels, saving approximately $X in premium."

G. PREVENTED PLANTING
- Are prevented planting provisions set correctly?
- Has the farmer had PP claims before?
- Should they elect the additional 5% PP coverage buy-up?

H. ACREAGE VERIFICATION
- Do reported acres match what the farmer described?
- Are there crops the farmer grows that aren't on the policy?
- Are there acres that appear uninsured?

I. ENDORSEMENT REVIEW
- Are all endorsements current and applicable?
- Are there endorsements that should be added?
- Are there outdated endorsements costing premium for no benefit?

J. KEY DATES CHECK
- Are there upcoming deadlines the farmer should be aware of?
- Sales closing dates, acreage reporting dates, production reporting dates

STEP 4: COST IMPACT CALCULATION
For EVERY finding, you MUST calculate the dollar impact. Be specific:
- "This is costing you approximately $X per year in excess premium"
- "This gap leaves you exposed to $X in potential uncovered losses"
- "Fixing this could save you $X annually"
- "In a loss year, this error could cost you $X in claim payments"
- Show your math when possible. Use actual numbers from the policy.
- Use current RMA premium rates for the state/county when estimating
- Be conservative but realistic — round to the nearest $50 for small amounts, nearest $100 for larger

STEP 5: AGENT CONVERSATION SCRIPTS
For EVERY finding, write a specific script the farmer can use with their agent. These should be:
- Written in first person as if the farmer is speaking
- Professional but firm
- Specific about what needs to change
- Include the relevant policy details so the agent knows exactly what to look at

Example agent scripts:
- "I'd like to discuss switching my corn from Optional to Enterprise units. Based on my acreage, I believe this could save me around $X in premium. Can you run the numbers on that for me?"
- "I noticed my practice code for the west quarter is listed as non-irrigated, but I installed a pivot on that field two years ago. That's 160 irrigated acres that should be coded as practice code 003. Can we get that corrected before the acreage reporting deadline?"
- "I want to look at adding Supplemental Coverage Option to my soybeans. What would the premium be for the 86% to 75% coverage band?"
- "My APH shows a T-yield for 2021, but I have actual production records for that year. I'd like to submit my records to replace that plug yield. My actual yield was X bushels per acre, which would raise my APH."

STEP 6: EXECUTIVE SUMMARY
Write a comprehensive 3-4 paragraph executive summary that:
- Opens with a clear statement of the overall policy health (e.g., "Our independent review of your crop insurance policy for [Farm Name] identified [X] areas requiring attention, with a combined estimated impact of $[total].")
- Summarizes the most critical findings in plain language
- Gives the total estimated financial impact (savings + risk exposure combined)
- Lists the top 2-3 priority actions the farmer should take immediately
- Ends with a note about upcoming deadlines if relevant
- Uses a professional but approachable tone — like a trusted advisor, not a salesperson

====================================================================
CRITICAL RULES
====================================================================
- ONLY report findings you can support with evidence from the documents or questionnaire
- Do NOT hallucinate, fabricate, or assume information not present in the documents
- If you cannot see enough detail in a document image, say so — do not guess
- If you are uncertain about a finding, mark it as "warning" severity and explicitly state what you're uncertain about
- Every dollar estimate must be based on real policy data, real rates, or reasonable industry averages
- Do not round estimates to suspiciously clean numbers ($1,000, $5,000) — use realistic figures ($1,150, $4,780)
- Write everything in plain English a farmer without insurance expertise can understand
- If the policy is genuinely well-structured with no issues, say so — do not manufacture problems

====================================================================
FORMAT YOUR RESPONSE AS JSON:
====================================================================
{
  "findings": [
    {
      "title": "Clear, specific title of the finding",
      "description": "Detailed description of what was found, with specific numbers from the policy. Explain what is currently on the policy and what it should be.",
      "why_it_matters": "Specific explanation of the financial or coverage impact. Include dollar amounts. Explain what happens in a loss scenario if this isn't fixed.",
      "agent_language": "Exact script the farmer should use when talking to their agent. Written in first person. Professional, specific, and actionable.",
      "severity": "critical|warning|ok",
      "estimated_impact": 0,
      "document_id": "string or null",
      "highlight_coords": { "top": 0, "left": 0, "width": 0, "height": 0 }
    }
  ],
  "executive_summary": "Full 3-4 paragraph executive summary as described above. This will be shown directly to the farmer, so make it professional and clear."
}`;
}

function parseAnalysisResponse(responseText) {
  try {
    // Try to extract JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*"findings"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        findings: parsed.findings || [],
        executiveSummary: parsed.executive_summary || null
      };
    }
  } catch (e) {
    console.error('Failed to parse AI response as JSON:', e.message);
  }

  // Fallback: create a single finding with the raw text
  return {
    findings: [{
      title: 'AI Analysis Results',
      description: responseText.substring(0, 1000),
      why_it_matters: 'Review the full analysis and extract specific findings manually.',
      agent_language: '',
      severity: 'warning',
      estimated_impact: 0
    }],
    executiveSummary: null
  };
}
