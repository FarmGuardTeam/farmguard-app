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

    // 4. For image and PDF documents, get their URLs for Claude's vision capability
    const visualDocuments = documents.filter(d =>
      d.file_name?.match(/\.(jpg|jpeg|png|tiff|tif|pdf)$/i)
    );

    // Build content blocks for Claude (text + images)
    const contentBlocks = [];

    // Add text context
    contentBlocks.push({
      type: 'text',
      text: buildAnalysisPrompt(audit, questionnaire, documents)
    });

    // Add visual documents for analysis (images + PDFs)
    // Prioritize Schedule of Insurance and APH docs first, then other policy documents
    visualDocuments.sort((a, b) => {
      const priority = (name) => {
        const n = name.toLowerCase();
        if (n.includes('schedule')) return 0;
        if (n.includes('aph') || n.includes('yield') || n.includes('production')) return 1;
        return 2;
      };
      return priority(a.file_name) - priority(b.file_name);
    });
    for (const doc of visualDocuments.slice(0, 10)) {
      try {
        const docUrl = `${SUPABASE_URL}/storage/v1/object/public/policy-documents/${doc.file_path}`;
        const docRes = await fetch(docUrl);
        if (docRes.ok) {
          const buffer = await docRes.arrayBuffer();
          const base64 = Buffer.from(buffer).toString('base64');

          const isPdf = doc.file_name.match(/\.pdf$/i);
          const mediaType = isPdf ? 'application/pdf'
            : doc.file_name.match(/\.png$/i) ? 'image/png'
            : 'image/jpeg';

          if (isPdf) {
            // Claude supports PDF documents via the document source type
            contentBlocks.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 }
            });
          } else {
            contentBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 }
            });
          }

          // Label identifying which document this is
          const docLabel = doc.file_name.toLowerCase().includes('schedule') ? 'SCHEDULE OF INSURANCE'
            : doc.file_name.toLowerCase().includes('aph') ? 'APH / YIELD HISTORY'
            : doc.file_name.toLowerCase().includes('yield') ? 'APH / YIELD HISTORY'
            : doc.file_name.toLowerCase().includes('production') ? 'PRODUCTION HISTORY'
            : 'POLICY DOCUMENT';

          contentBlocks.push({
            type: 'text',
            text: `The above document is "${doc.file_name}" (Document ID: ${doc.id}, Type: ${docLabel}). Perform a line-by-line review. For Schedule of Insurance: verify every line item's plan, coverage level, unit structure, practice code, crop type, and acres. For APH/yield records: check every yield entry for T-yields, data entry errors, and Yield Exclusion eligibility.`
          });
        }
      } catch (e) {
        console.error('Failed to fetch document:', doc.file_name, e.message);
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
        max_tokens: 12288,
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
  return `You are a highly skilled, independent crop insurance underwriter and APH specialist with 20+ years of experience. You are conducting an in-depth policy audit for a commercial farmer. You work for FarmGuard, an independent audit service — you do NOT sell insurance and you earn NO commissions. Your only job is to find what's been left on the table and protect the farmer's financial interests.

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
AUDIT INSTRUCTIONS — LINE-BY-LINE SCHEDULE & APH REVIEW
====================================================================

You must perform two core audits on every document provided:

1) SCHEDULE OF INSURANCE — LINE-BY-LINE VERIFICATION
2) APH (ACTUAL PRODUCTION HISTORY) — FULL DATABASE AUDIT

This farmer is paying for a professional, independent review. Be thorough, specific, and blunt about what you find. Every finding should clearly state what's wrong, what it's costing them, and exactly what the agent needs to fix.

────────────────────────────────────────────────────────────────────
PART 1: SCHEDULE OF INSURANCE — LINE-BY-LINE REVIEW
────────────────────────────────────────────────────────────────────

Go through EVERY line item on the Schedule of Insurance. For each insured crop/unit, verify ALL of the following:

A. PLAN OF INSURANCE VERIFICATION
For each crop line, confirm the plan of insurance code is appropriate:
- RP (Revenue Protection) — includes harvest price protection. Best for most operations.
- RP-HPE (Revenue Protection with Harvest Price Exclusion) — saves premium but removes upside harvest price protection. Flag if the farmer may not realize they gave up harvest price coverage.
- YP (Yield Protection) — only covers yield loss, no revenue component. Flag if RP would be more appropriate.
- ARP (Area Risk Protection) — area-based, not individual. Flag if individual coverage would better fit.
- WFRP (Whole-Farm Revenue Protection) — check if diversified operations might benefit.
For each line, state: what plan is listed, whether it's the right fit, and what the farmer is giving up or gaining.

B. COVERAGE LEVEL VERIFICATION
For each crop line, check the coverage level percentage:
- Is each crop at the same coverage level, or are they different? If different, is there a strategic reason?
- At their operation size, would a higher or lower level be more cost-effective?
- Calculate the guarantee difference: (Acres × APH × Projected Price × Coverage%) and show how it changes at ±5%
- Flag any crop below 70% — most commercial operations benefit from at least 75%
- Flag any crop at 85% — confirm the premium cost is justified for their risk profile
- If the farmer has different coverage levels on different crops, verify there's a sound reason

C. UNIT STRUCTURE VERIFICATION
For each crop, confirm the unit structure:
- Basic Units — highest premium, smallest loss area. Rarely optimal for larger operations.
- Optional Units — moderate premium, units split by section/FSN. Good for diversified land.
- Enterprise Units (EU) — lowest premium, all acres of a crop in a county combined into one unit. Best for most operations over 500 acres.
- Whole-Farm Units — all crops combined.
Flag specifically:
- Operations over 500 acres NOT on Enterprise Units — calculate the premium savings of switching
- Operations on Basic Units when Optional or Enterprise would save money
- Any unit structure mismatch where the farmer is overpaying premium for coverage that doesn't match their risk

D. PRACTICE CODE VERIFICATION — THIS IS CRITICAL
For EVERY line item, verify the practice code matches the farmer's actual farming method:
- Practice 002 (Non-Irrigated / Dryland)
- Practice 003 (Irrigated)
- Practice 004 (Non-Irrigated Following Another Crop / Double-Crop)
- Practice 006 (Irrigated Following Another Crop)
- Practice 043 (Summer Fallow)
- Practice 044 (Continuous Cropping)
- Practice 053 (Irrigated, Skip Row)
Cross-reference with questionnaire answers:
- Did the farmer say they irrigate? Check if all irrigated acres are coded 003 or 006.
- Did the farmer mention double-cropping? Check for practice 004 or 006.
- Dryland coded as irrigated = farmer overpaying premium unnecessarily
- Irrigated coded as dryland = farmer SEVERELY under-covered. In a loss year, the indemnity will be calculated on dryland yields/prices, potentially costing tens of thousands.
- Wrong practice code is one of the most expensive and common errors. Check every single line.

E. CROP TYPE AND VARIETY VERIFICATION
For each crop line:
- Is the crop type correct (e.g., grain corn vs. silage corn, food-grade soybeans vs. commodity)?
- Is the type code matching what the farmer actually grows and markets?
- Different types have different premium rates and coverage — wrong type = wrong coverage

F. ACREAGE VERIFICATION
- Add up all insured acres per crop from the schedule
- Compare to what the farmer reported in the questionnaire
- Flag any discrepancy — missing acres = uninsured exposure
- Flag any crops the farmer says they grow but that don't appear on the schedule

G. COUNTY VERIFICATION
- Confirm each line item is listed under the correct county
- If the farmer operates in multiple counties, verify all counties are represented
- Wrong county = wrong premium rates and wrong APH base

H. SUPPLEMENTAL COVERAGE CHECK (SCO/ECO)
- If SCO (Supplemental Coverage Option) or ECO (Enhanced Coverage Option) is elected, verify:
  - SCO cannot be combined with Enterprise Units on the same crop in some cases
  - Coverage band makes sense for the operation
  - Premium cost vs. added coverage is justified
- If NOT elected, flag whether SCO/ECO should be considered and estimate the cost/benefit

I. PREVENTED PLANTING PROVISIONS
- What prevented planting coverage level is elected?
- Should the farmer buy up the additional 5% prevented planting coverage?
- Has the farmer had prevented planting events in recent years (check questionnaire)?

────────────────────────────────────────────────────────────────────
PART 2: APH (ACTUAL PRODUCTION HISTORY) — FULL DATABASE AUDIT
────────────────────────────────────────────────────────────────────

If APH yield records, production history, or yield databases are provided in the documents, perform a complete APH audit:

A. T-YIELD (PLUG YIELD / TRANSITIONAL YIELD) CHECK
- Identify ANY year in the APH database showing a T-yield (transitional yield / plug yield)
- T-yields are assigned when the farmer has no actual production records for that year
- T-yields are typically 60% of the county average — they DRAG DOWN the APH
- For each T-yield found:
  - State the crop year, crop, unit, and the T-yield amount
  - Ask: does the farmer have actual production records for that year? If so, submitting them could REPLACE the T-yield with a higher actual yield
  - Calculate how many bushels the APH would increase if the T-yield were replaced with a reasonable actual yield (use their other years' average as an estimate)
  - Calculate the dollar impact: (APH increase × acres × projected price × coverage level = additional guarantee dollars)
- T-yields are one of the BIGGEST sources of money left on the table. Be aggressive about flagging every one.

B. DATA ENTRY ERROR CHECK
- Look at the yield history year by year for each crop/unit
- Flag any yield that is dramatically out of line with the other years (e.g., other years are 170-195 bu/acre but one year shows 45 bu/acre or 350 bu/acre)
- An abnormally LOW yield could be:
  - A legitimate loss year (check if there was a claim)
  - A data entry error (decimal in wrong place, wrong unit, acres reported incorrectly)
  - Production from a partial year entered as a full-year yield
- An abnormally HIGH yield could be:
  - Data entry error (irrigated yield entered on dryland unit, or vice versa)
  - Wrong acreage divisor used
- For each suspicious yield:
  - State the year, crop, unit, yield amount, and why it looks wrong
  - State what the yield "should" likely be based on the surrounding years
  - Calculate the APH impact of correcting it

C. YIELD EXCLUSION (YE) ELIGIBILITY CHECK
- Yield Exclusion allows farmers to DROP their worst yield year(s) from the APH if the county experienced a disaster (county average was below a threshold set by RMA)
- Check: is the farmer's county eligible for Yield Exclusion for any crop year in their APH?
- For each eligible year:
  - Identify the year and crop
  - Show what the farmer's yield was that year vs. their average
  - Calculate the APH WITH and WITHOUT that year excluded
  - Calculate the dollar impact of the higher APH (more guarantee = more protection = potentially lower premium per dollar of coverage)
- If YE is already being applied, confirm it's being applied to the right year(s)
- If YE is NOT being applied but the county is eligible, flag this as CRITICAL — this is pure money left on the table

D. APH TREND ANALYSIS
- Is the farmer's APH trending up or down over recent years?
- If trending up, are the most recent high-yield years being properly captured?
- If trending down, are there data issues that might be causing the decline?
- Compare the farmer's APH to the county average yield — if significantly below, investigate why

E. APPROVED YIELD CALCULATION VERIFICATION
- Verify the APH yield calculation: sum of actual yields ÷ number of years (up to 10)
- Check if the math is correct
- Verify the correct number of years is being used
- Confirm the approved APH yield matches what should be calculated from the data

────────────────────────────────────────────────────────────────────
PART 3: CROSS-REFERENCE SCHEDULE WITH QUESTIONNAIRE
────────────────────────────────────────────────────────────────────

Compare the farmer's questionnaire answers with the Schedule of Insurance:
- Crops match? Acres match? Counties match?
- Practice codes match their stated farming methods (irrigated vs. dryland, double-crop)?
- Any concerns they raised that are confirmed or contradicted by the documents?
- Any crops or fields they mentioned that are MISSING from the schedule?

────────────────────────────────────────────────────────────────────
PART 4: DOLLAR IMPACT — WHAT'S LEFT ON THE TABLE
────────────────────────────────────────────────────────────────────

For EVERY finding, calculate and clearly state the dollar impact:
- "Fixing this would increase your coverage guarantee by $X"
- "This error is costing you approximately $X per year in excess premium"
- "In a loss year, this mistake could cost you $X in claim payments"
- "Correcting this T-yield would raise your APH by X bu/acre, adding $X to your guarantee"
- Show your math. Use real numbers from the policy documents.
- Be conservative but realistic — use actual figures, not rounded thousands
- The total of all findings = "What's Left on the Table" — this is the headline number

────────────────────────────────────────────────────────────────────
PART 5: AGENT-READY FINDINGS
────────────────────────────────────────────────────────────────────

For EVERY finding, write a word-for-word script the farmer can take directly to their insurance agent. These scripts must be:
- Written in first person as if the farmer is speaking
- Professional, specific, and direct
- Reference exact policy details (crop, unit, practice code, year, yield amount)
- Tell the agent exactly what needs to change
- Include the financial reasoning so the agent takes it seriously

Examples:
- "I'm looking at my Schedule of Insurance and I see my corn on the Johnson quarter is listed as practice code 002, non-irrigated. I put a pivot on that field in 2023 — those 130 acres should be practice code 003, irrigated. Can we get that corrected? I believe my coverage is significantly understated on those acres."
- "My APH database shows a T-yield of 112 bushels for 2020, but I have my actual production records from that year — I harvested 183 bushels per acre. I'd like to submit those records to replace the T-yield. That should raise my APH by about 7 bushels per acre."
- "I'd like to discuss whether Yield Exclusion would benefit me. My 2019 yield was 98 bushels against my average of 185. If that year qualifies for YE in our county, dropping it from my APH calculation could raise my approved yield significantly."
- "I notice I'm on RP-HPE for my soybeans. I want to make sure I understand what I'm giving up — can you show me what RP would cost by comparison? I want to know if the harvest price protection is worth the extra premium for my operation."

────────────────────────────────────────────────────────────────────
PART 6: EXECUTIVE SUMMARY
────────────────────────────────────────────────────────────────────

Write a clear, professional executive summary (3-4 paragraphs):
- Open with: "Our independent review of your crop insurance policy for [Farm Name] identified [X] findings with a combined estimated impact of $[total]. Here's what we found."
- Summarize the most important findings in plain English
- State the total "Left on the Table" dollar amount prominently
- List the top 2-3 things the farmer should ask their agent to fix FIRST
- Mention any upcoming deadlines (sales closing, acreage reporting, production reporting)
- Tone: trusted advisor who just saved them money — confident, clear, no jargon

====================================================================
CRITICAL RULES
====================================================================
- ONLY report findings backed by evidence from the documents or questionnaire
- Do NOT hallucinate, fabricate, or assume data that isn't visible in the documents
- If a document image is blurry or you can't read specific values, SAY SO — do not guess
- If uncertain about a finding, mark severity as "warning" and state what you're uncertain about
- Every dollar estimate must use real numbers from the documents — no invented figures
- Do not round to clean numbers ($1,000, $5,000) — use realistic figures ($1,150, $4,780)
- Write in plain English a farmer can understand — no insurance jargon without explanation
- If the policy is well-structured with no issues, say so honestly — do not manufacture findings
- Focus on ACTIONABLE findings the agent can actually fix — no vague observations

====================================================================
FORMAT YOUR RESPONSE AS JSON:
====================================================================
{
  "findings": [
    {
      "title": "Clear, specific title (e.g., 'T-Yield on 2020 Corn Dragging Down APH' or 'Wrong Practice Code on NE Quarter')",
      "description": "What you found — reference exact line items, crop years, unit numbers, practice codes, yield values from the documents. State what IS on the policy and what it SHOULD be.",
      "why_it_matters": "The dollar impact. How much this is costing them, how much they'd gain by fixing it, and what happens in a loss year if it stays wrong. Show your math.",
      "agent_language": "Word-for-word script the farmer reads to their agent. First person, professional, specific. References the exact policy details so the agent knows exactly what to look at and fix.",
      "severity": "critical|warning|ok",
      "estimated_impact": 0,
      "document_id": "string or null",
      "highlight_coords": { "top": 0, "left": 0, "width": 0, "height": 0 }
    }
  ],
  "executive_summary": "3-4 paragraph summary as described above. This goes directly to the farmer — make it clear, professional, and worth the money they paid."
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
