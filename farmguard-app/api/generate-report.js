// Vercel Serverless Function: PDF Report Generator
// Generates a professional PDF audit report (ChargeRight-style) using PDFKit.
// Called from admin panel when approving an audit, or on-demand from report page.

import PDFDocument from 'pdfkit';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { audit_id } = req.body;
  if (!audit_id) {
    return res.status(400).json({ error: 'Missing audit_id' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  const headers = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
  };

  try {
    // 1. Fetch all audit data
    const [auditRes, findingsRes, docsRes, qRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/audits?id=eq.${audit_id}&select=*`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/findings?audit_id=eq.${audit_id}&select=*&order=severity.desc`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/documents?audit_id=eq.${audit_id}&select=*`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/questionnaire_responses?audit_id=eq.${audit_id}&select=*`, { headers })
    ]);

    const audits = await auditRes.json();
    if (!audits || audits.length === 0) {
      return res.status(404).json({ error: 'Audit not found' });
    }

    const audit = audits[0];
    const findings = await findingsRes.json() || [];
    const documents = await docsRes.json() || [];
    const qData = await qRes.json();
    const questionnaire = qData?.[0]?.responses || {};

    // 2. Fetch document images for embedding
    const docImages = [];
    const imageDocuments = documents.filter(d =>
      d.file_name?.match(/\.(jpg|jpeg|png)$/i)
    );

    for (const doc of imageDocuments.slice(0, 3)) {
      try {
        const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/policy-documents/${doc.file_path}`;
        const imgRes = await fetch(imageUrl);
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          const ext = doc.file_name.match(/\.png$/i) ? 'png' : 'jpeg';
          docImages.push({ name: doc.file_name, buffer, ext, docId: doc.id });
        }
      } catch (e) {
        console.error('Failed to fetch image:', doc.file_name);
      }
    }

    // 3. Generate PDF
    const pdfBuffer = await generatePDF(audit, findings, documents, questionnaire, docImages);

    // 4. Upload PDF to Supabase storage
    const pdfFileName = `${audit.audit_id || audit_id}/FarmGuard-Report-${audit.audit_id || 'audit'}.pdf`;

    await fetch(`${SUPABASE_URL}/storage/v1/object/policy-documents/${pdfFileName}`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/pdf',
        'x-upsert': 'true'
      },
      body: pdfBuffer
    });

    // 5. Get public URL
    const pdfUrl = `${SUPABASE_URL}/storage/v1/object/public/policy-documents/${pdfFileName}`;

    // 6. Save PDF URL to audit record
    await fetch(`${SUPABASE_URL}/rest/v1/audits?id=eq.${audit_id}`, {
      method: 'PATCH',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ pdf_report_url: pdfUrl })
    });

    return res.status(200).json({ success: true, pdf_url: pdfUrl });

  } catch (err) {
    console.error('PDF generation error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ===================== PDF GENERATION =====================

async function generatePDF(audit, findings, documents, questionnaire, docImages) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'letter',
      margins: { top: 50, bottom: 50, left: 55, right: 55 },
      info: {
        Title: `FarmGuard Policy Audit - ${audit.farm_name || 'Report'}`,
        Author: 'FarmGuard',
        Subject: 'Crop Insurance Policy Audit Report',
        Creator: 'FarmGuard Audit System'
      }
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right; // usable width
    const LEFT = doc.page.margins.left;

    // Brand colors
    const GREEN_DARK = '#2D5016';
    const GREEN_MID = '#4A7C23';
    const GOLD = '#D4A843';
    const CREAM = '#F7F6F1';
    const NAVY = '#1B2A4A';
    const RED = '#D32F2F';
    const ORANGE = '#F57C00';
    const GRAY_LIGHT = '#F5F5F5';
    const GRAY_MID = '#888888';
    const GRAY_BORDER = '#E0E0E0';
    const WHITE = '#FFFFFF';

    // Severity colors
    const severityColor = (s) => s === 'critical' ? RED : s === 'warning' ? ORANGE : GREEN_MID;
    const severityLabel = (s) => s === 'critical' ? 'CRITICAL' : s === 'warning' ? 'WARNING' : 'OK';

    // Calculated values
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const warningCount = findings.filter(f => f.severity === 'warning').length;
    const okCount = findings.filter(f => f.severity === 'ok').length;
    const totalImpact = findings.reduce((sum, f) => sum + (f.estimated_impact || 0), 0);
    const reportDate = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });

    // ==================== HELPER FUNCTIONS ====================

    function ensureSpace(needed) {
      if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
    }

    function drawHorizontalRule(color = GREEN_MID, thickness = 2) {
      doc.save()
        .moveTo(LEFT, doc.y)
        .lineTo(LEFT + W, doc.y)
        .lineWidth(thickness)
        .strokeColor(color)
        .stroke()
        .restore();
      doc.y += 8;
    }

    function sectionHeader(icon, title) {
      ensureSpace(40);
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(NAVY).text(title.toUpperCase(), LEFT, doc.y, { continued: false });
      doc.y += 2;
      drawHorizontalRule(GREEN_MID, 1.5);
      doc.moveDown(0.3);
    }

    function drawRoundedRect(x, y, w, h, r, fillColor, strokeColor) {
      doc.save();
      if (fillColor) doc.roundedRect(x, y, w, h, r).fill(fillColor);
      if (strokeColor) doc.roundedRect(x, y, w, h, r).lineWidth(1).strokeColor(strokeColor).stroke();
      doc.restore();
    }

    function drawStatBox(x, y, w, h, value, label, valueColor = GREEN_DARK) {
      drawRoundedRect(x, y, w, h, 4, WHITE, GRAY_BORDER);
      doc.fontSize(22).font('Helvetica-Bold').fillColor(valueColor)
        .text(value, x, y + 12, { width: w, align: 'center' });
      doc.fontSize(9).font('Helvetica').fillColor(GRAY_MID)
        .text(label, x, y + 38, { width: w, align: 'center' });
    }

    function wrapText(text, maxWidth, fontSize) {
      doc.fontSize(fontSize).font('Helvetica');
      const words = (text || '').split(' ');
      const lines = [];
      let currentLine = '';
      for (const word of words) {
        const testLine = currentLine ? currentLine + ' ' + word : word;
        if (doc.widthOfString(testLine) > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) lines.push(currentLine);
      return lines;
    }

    // ==================== PAGE 1: COVER / SUMMARY ====================

    // Header bar
    doc.rect(0, 0, doc.page.width, 88).fill(WHITE);

    // Logo area
    doc.fontSize(20).font('Helvetica-Bold').fillColor(GREEN_DARK)
      .text('FarmGuard', LEFT, 24);
    doc.fontSize(9).font('Helvetica').fillColor(GREEN_MID)
      .text('INDEPENDENT POLICY AUDIT', LEFT, 48);

    // Right side - date and report ID
    doc.fontSize(10).font('Helvetica-Bold').fillColor(NAVY)
      .text(reportDate, LEFT + W - 150, 24, { width: 150, align: 'right' });
    doc.fontSize(9).font('Helvetica').fillColor(GRAY_MID)
      .text(`Report ID: ${audit.audit_id || 'N/A'}`, LEFT + W - 150, 38, { width: 150, align: 'right' });
    doc.fontSize(9).font('Helvetica').fillColor(GREEN_MID)
      .text('farmguard.com', LEFT + W - 150, 51, { width: 150, align: 'right' });

    // Green divider line
    doc.y = 80;
    drawHorizontalRule(GREEN_MID, 3);

    // Title Section
    doc.moveDown(0.5);
    doc.fontSize(20).font('Helvetica-Bold').fillColor(NAVY)
      .text('Crop Insurance Policy Audit', LEFT);
    doc.fontSize(10).font('Helvetica').fillColor(GRAY_MID)
      .text(`${audit.farm_name || 'Farm'} | ${audit.crops || 'Crops'} | ${audit.acres ? audit.acres + ' acres' : ''}`, LEFT);

    // Location box (right side)
    const locBoxX = LEFT + W - 120;
    const locBoxY = doc.y - 30;
    doc.fontSize(8).font('Helvetica').fillColor(GRAY_MID)
      .text('LOCATION', locBoxX, locBoxY, { width: 120, align: 'right' });
    doc.fontSize(11).font('Helvetica-Bold').fillColor(NAVY)
      .text(`${audit.county || ''}, ${audit.state || ''}`, locBoxX, locBoxY + 12, { width: 120, align: 'right' });

    doc.moveDown(1.2);

    // Status Banner
    const bannerY = doc.y;
    const bannerH = 65;

    // Green left accent bar
    doc.rect(LEFT, bannerY, 5, bannerH).fill(GREEN_MID);
    // Banner background
    doc.rect(LEFT + 5, bannerY, W - 5, bannerH).fill('#F0F7EC');

    // Banner text
    const hasIssues = criticalCount > 0;
    const bannerTitle = hasIssues ? 'ACTION RECOMMENDED' : 'POLICY REVIEW COMPLETE';
    const bannerColor = hasIssues ? ORANGE : GREEN_MID;

    doc.fontSize(16).font('Helvetica-Bold').fillColor(bannerColor)
      .text(bannerTitle, LEFT + 16, bannerY + 10);
    doc.fontSize(9).font('Helvetica').fillColor('#555555')
      .text(
        `Our independent review identified ${findings.length} finding${findings.length !== 1 ? 's' : ''} with a combined estimated impact of $${totalImpact.toLocaleString()}.`,
        LEFT + 16, bannerY + 32, { width: W * 0.55 }
      );

    // Banner right stats
    const stat1X = LEFT + W - 190;
    const stat2X = LEFT + W - 90;
    doc.fontSize(24).font('Helvetica-Bold').fillColor(criticalCount > 0 ? RED : GREEN_MID)
      .text(String(criticalCount), stat1X, bannerY + 10, { width: 80, align: 'center' });
    doc.fontSize(8).font('Helvetica').fillColor(GRAY_MID)
      .text('CRITICAL', stat1X, bannerY + 38, { width: 80, align: 'center' });

    doc.fontSize(24).font('Helvetica-Bold').fillColor(NAVY)
      .text(String(findings.length), stat2X, bannerY + 10, { width: 80, align: 'center' });
    doc.fontSize(8).font('Helvetica').fillColor(GRAY_MID)
      .text('TOTAL', stat2X, bannerY + 38, { width: 80, align: 'center' });

    doc.y = bannerY + bannerH + 20;

    // ==================== KEY METRICS BOXES ====================
    sectionHeader('', 'YOUR AUDIT AT A GLANCE');

    const boxY = doc.y;
    const boxW = (W - 24) / 4;
    const boxH = 58;

    drawStatBox(LEFT, boxY, boxW, boxH,
      String(findings.length), 'Total Findings', NAVY);
    drawStatBox(LEFT + boxW + 8, boxY, boxW, boxH,
      String(criticalCount), 'Critical Issues', criticalCount > 0 ? RED : GREEN_MID);
    drawStatBox(LEFT + (boxW + 8) * 2, boxY, boxW, boxH,
      '$' + totalImpact.toLocaleString(), 'Est. Impact', GREEN_DARK);
    drawStatBox(LEFT + (boxW + 8) * 3, boxY, boxW, boxH,
      String(warningCount), 'Warnings', warningCount > 0 ? ORANGE : GREEN_MID);

    doc.y = boxY + boxH + 8;
    doc.fontSize(8).font('Helvetica').fillColor(GRAY_MID)
      .text('Estimated impact includes potential savings and risk exposure. Actual amounts depend on market conditions and loss events.', LEFT);

    doc.moveDown(1);

    // ==================== FARM PROFILE ====================
    sectionHeader('', 'YOUR FARM PROFILE');

    const profileData = [
      ['Farm Name', audit.farm_name || 'N/A', 'State', audit.state || 'N/A'],
      ['County', audit.county || 'N/A', 'Total Acres', audit.acres ? String(audit.acres) : 'N/A'],
      ['Crops Insured', audit.crops || 'N/A', 'Documents', String(documents.length)],
    ];

    // Add questionnaire data if available
    if (questionnaire.coverage_level) {
      profileData.push(['Coverage Level', questionnaire.coverage_level, 'Unit Structure', questionnaire.unit_structure || 'N/A']);
    }
    if (questionnaire.irrigation) {
      profileData.push(['Irrigation', questionnaire.irrigation, 'Double Cropping', questionnaire.following_crop || 'N/A']);
    }

    const colW = W / 2;
    const rowH = 22;
    let profileY = doc.y;

    for (const row of profileData) {
      ensureSpace(rowH + 4);
      // Left pair
      doc.fontSize(9).font('Helvetica').fillColor(GRAY_MID)
        .text(row[0], LEFT, profileY, { width: colW * 0.5 });
      doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY)
        .text(row[1], LEFT + colW * 0.5 - 20, profileY, { width: colW * 0.5, align: 'right' });

      // Right pair
      doc.fontSize(9).font('Helvetica').fillColor(GRAY_MID)
        .text(row[2], LEFT + colW + 10, profileY, { width: colW * 0.5 - 10 });
      doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY)
        .text(row[3], LEFT + colW + colW * 0.5 - 10, profileY, { width: colW * 0.5, align: 'right' });

      profileY += rowH;
      // Separator line
      doc.save().moveTo(LEFT, profileY - 4).lineTo(LEFT + W, profileY - 4)
        .lineWidth(0.5).strokeColor(GRAY_BORDER).stroke().restore();
    }
    doc.y = profileY + 8;

    // ==================== EXECUTIVE SUMMARY ====================
    if (audit.executive_summary) {
      ensureSpace(80);
      sectionHeader('', 'EXECUTIVE SUMMARY');

      const summaryLines = (audit.executive_summary || '').split('\n').filter(l => l.trim());
      for (const para of summaryLines) {
        ensureSpace(40);
        doc.fontSize(10).font('Helvetica').fillColor('#333333')
          .text(para.trim(), LEFT, doc.y, { width: W, lineGap: 3 });
        doc.moveDown(0.5);
      }
    }

    // ==================== PAGE 2+: DETAILED FINDINGS ====================
    doc.addPage();

    sectionHeader('', 'DETAILED FINDINGS');

    if (findings.length === 0) {
      doc.fontSize(10).font('Helvetica').fillColor(GRAY_MID)
        .text('No findings were identified in this audit. Your policy appears to be well-structured.', LEFT);
    }

    // Findings summary table
    if (findings.length > 0) {
      const tableX = LEFT;
      let tableY = doc.y;
      const tColWidths = [30, W * 0.42, 70, 80, W * 0.15];
      const tRowH = 24;

      // Table header
      doc.rect(tableX, tableY, W, tRowH).fill(NAVY);
      doc.fontSize(8).font('Helvetica-Bold').fillColor(WHITE);
      doc.text('#', tableX + 8, tableY + 7, { width: tColWidths[0] });
      doc.text('Finding', tableX + tColWidths[0] + 8, tableY + 7, { width: tColWidths[1] });
      doc.text('Severity', tableX + tColWidths[0] + tColWidths[1] + 8, tableY + 7, { width: tColWidths[2] });
      doc.text('Est. Impact', tableX + tColWidths[0] + tColWidths[1] + tColWidths[2] + 8, tableY + 7, { width: tColWidths[3] });
      doc.text('Status', tableX + tColWidths[0] + tColWidths[1] + tColWidths[2] + tColWidths[3] + 8, tableY + 7, { width: tColWidths[4] });
      tableY += tRowH;

      // Table rows
      findings.forEach((f, i) => {
        ensureSpace(tRowH + 4);
        tableY = doc.y;
        const bgColor = i % 2 === 0 ? GRAY_LIGHT : WHITE;
        doc.rect(tableX, tableY, W, tRowH).fill(bgColor);

        doc.fontSize(8).font('Helvetica').fillColor(NAVY);
        doc.text(String(i + 1), tableX + 8, tableY + 7, { width: tColWidths[0] });

        // Truncate title if needed
        const maxTitleLen = 50;
        const title = (f.title || '').length > maxTitleLen ? (f.title || '').substring(0, maxTitleLen) + '...' : (f.title || '');
        doc.text(title, tableX + tColWidths[0] + 8, tableY + 7, { width: tColWidths[1] });

        // Severity badge
        const sevX = tableX + tColWidths[0] + tColWidths[1] + 8;
        doc.fontSize(7).font('Helvetica-Bold').fillColor(severityColor(f.severity))
          .text(severityLabel(f.severity), sevX, tableY + 8, { width: tColWidths[2] });

        // Impact
        const impX = tableX + tColWidths[0] + tColWidths[1] + tColWidths[2] + 8;
        doc.fontSize(8).font('Helvetica-Bold').fillColor(f.estimated_impact > 0 ? RED : GRAY_MID)
          .text(f.estimated_impact ? '$' + f.estimated_impact.toLocaleString() : '-', impX, tableY + 7, { width: tColWidths[3] });

        // Status
        const statX = tableX + tColWidths[0] + tColWidths[1] + tColWidths[2] + tColWidths[3] + 8;
        doc.fontSize(7).font('Helvetica').fillColor(GRAY_MID)
          .text('Action Needed', statX, tableY + 8, { width: tColWidths[4] });

        doc.y = tableY + tRowH;
      });

      doc.moveDown(1.5);
    }

    // ==================== INDIVIDUAL FINDING DETAILS ====================
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];

      ensureSpace(120);

      // Finding card
      const cardY = doc.y;
      const sevColor = severityColor(f.severity);

      // Severity accent bar
      doc.rect(LEFT, cardY, 4, 16).fill(sevColor);

      // Finding number and title
      doc.fontSize(12).font('Helvetica-Bold').fillColor(NAVY)
        .text(`Finding #${i + 1}: ${f.title || 'Untitled'}`, LEFT + 12, cardY);

      // Severity + impact line
      doc.y = cardY + 18;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(sevColor)
        .text(severityLabel(f.severity), LEFT + 12, doc.y, { continued: true });
      if (f.estimated_impact) {
        doc.fillColor(GRAY_MID).font('Helvetica')
          .text(`   |   Estimated Impact: `, { continued: true });
        doc.font('Helvetica-Bold').fillColor(RED)
          .text(`$${f.estimated_impact.toLocaleString()}`);
      } else {
        doc.text('');
      }

      doc.moveDown(0.4);

      // Description
      if (f.description) {
        ensureSpace(30);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text('What We Found:', LEFT + 12);
        doc.fontSize(9).font('Helvetica').fillColor('#444444')
          .text(f.description, LEFT + 12, doc.y, { width: W - 24, lineGap: 2 });
        doc.moveDown(0.4);
      }

      // Why it matters
      if (f.why_it_matters) {
        ensureSpace(30);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text('Why It Matters:', LEFT + 12);
        doc.fontSize(9).font('Helvetica').fillColor('#444444')
          .text(f.why_it_matters, LEFT + 12, doc.y, { width: W - 24, lineGap: 2 });
        doc.moveDown(0.4);
      }

      // Agent language (highlighted box)
      if (f.agent_language) {
        ensureSpace(50);
        const agentY = doc.y;

        // Calculate text height first
        const agentTextHeight = doc.heightOfString(f.agent_language, { width: W - 56, fontSize: 9 });
        const agentBoxH = agentTextHeight + 30;

        ensureSpace(agentBoxH + 8);
        const boxStartY = doc.y;

        // Light green background box
        drawRoundedRect(LEFT + 12, boxStartY, W - 24, agentBoxH, 4, '#F0F7EC', '#C5DEB5');

        doc.fontSize(8).font('Helvetica-Bold').fillColor(GREEN_DARK)
          .text('TELL YOUR AGENT:', LEFT + 22, boxStartY + 8);
        doc.fontSize(9).font('Helvetica').fillColor('#333333')
          .text(`"${f.agent_language}"`, LEFT + 22, boxStartY + 20, { width: W - 56, lineGap: 2 });

        doc.y = boxStartY + agentBoxH + 8;
      }

      // Separator between findings
      if (i < findings.length - 1) {
        doc.moveDown(0.3);
        doc.save().moveTo(LEFT + 12, doc.y).lineTo(LEFT + W - 12, doc.y)
          .lineWidth(0.5).strokeColor(GRAY_BORDER).stroke().restore();
        doc.moveDown(0.8);
      }
    }

    // ==================== ANNOTATED DOCUMENTS ====================
    if (docImages.length > 0) {
      doc.addPage();
      sectionHeader('', 'POLICY DOCUMENT REVIEW');

      doc.fontSize(9).font('Helvetica').fillColor(GRAY_MID)
        .text('Your uploaded policy documents are shown below. Numbered markers indicate where findings were identified.', LEFT);
      doc.moveDown(0.8);

      for (const img of docImages) {
        ensureSpace(250);

        // Document label
        doc.fontSize(10).font('Helvetica-Bold').fillColor(NAVY)
          .text(img.name, LEFT);
        doc.moveDown(0.3);

        const imgY = doc.y;
        try {
          // Fit image to page width
          doc.image(img.buffer, LEFT, imgY, { width: W, fit: [W, 400] });
          doc.y = imgY + Math.min(400, W * 0.75); // Estimate image height

          // Draw finding markers on the image
          const relatedFindings = findings.filter(f => f.document_id === img.docId);
          relatedFindings.forEach((f, idx) => {
            if (f.highlight_coords) {
              const hx = LEFT + (f.highlight_coords.left / 100) * W;
              const hy = imgY + (f.highlight_coords.top / 100) * 400;
              const hw = (f.highlight_coords.width / 100) * W;
              const hh = (f.highlight_coords.height / 100) * 400;

              // Red highlight box
              doc.save()
                .rect(hx, hy, hw, hh)
                .lineWidth(2)
                .strokeColor(RED)
                .stroke()
                .restore();

              // Number circle
              doc.save()
                .circle(hx + hw + 8, hy, 8)
                .fill(RED);
              doc.fontSize(7).font('Helvetica-Bold').fillColor(WHITE)
                .text(String(idx + 1), hx + hw + 2, hy - 4, { width: 12, align: 'center' });
              doc.restore();
            }
          });
        } catch (imgErr) {
          doc.fontSize(9).font('Helvetica').fillColor(GRAY_MID)
            .text('[Document image could not be embedded]', LEFT, imgY);
        }

        doc.moveDown(1);
        doc.fontSize(8).font('Helvetica').fillColor(GRAY_MID)
          .text('Source: Uploaded by Customer', LEFT, doc.y, { align: 'center', width: W });
        doc.moveDown(1.5);
      }
    }

    // ==================== ACTION PLAN ====================
    doc.addPage();
    sectionHeader('', 'AGENT-READY ACTION PLAN');

    doc.fontSize(9).font('Helvetica').fillColor(GRAY_MID)
      .text('Take this section directly to your insurance agent. Each item includes the exact language to use in your conversation.', LEFT);
    doc.moveDown(1);

    const priorityFindings = findings.filter(f => f.severity === 'critical');
    const secondaryFindings = findings.filter(f => f.severity === 'warning');
    const okFindings = findings.filter(f => f.severity === 'ok');

    if (priorityFindings.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(RED)
        .text('Priority Actions — Address Before Next Renewal', LEFT);
      doc.moveDown(0.5);

      priorityFindings.forEach((f, i) => {
        ensureSpace(60);
        const actionY = doc.y;
        drawRoundedRect(LEFT, actionY, W, 50, 4, '#FFF8F6', '#FFCDD2');

        doc.fontSize(10).font('Helvetica-Bold').fillColor(RED)
          .text(`${i + 1}. ${f.title}`, LEFT + 12, actionY + 8, { width: W - 24 });

        if (f.agent_language) {
          doc.fontSize(9).font('Helvetica').fillColor('#555555')
            .text(`"${f.agent_language}"`, LEFT + 12, actionY + 24, { width: W - 24, lineGap: 2 });
        }

        // Recalculate box height based on content
        doc.y = Math.max(doc.y, actionY + 50) + 8;
      });

      doc.moveDown(0.5);
    }

    if (secondaryFindings.length > 0) {
      ensureSpace(40);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(ORANGE)
        .text('Secondary Actions — Consider for Future', LEFT);
      doc.moveDown(0.5);

      secondaryFindings.forEach((f, i) => {
        ensureSpace(60);
        const actionY = doc.y;
        drawRoundedRect(LEFT, actionY, W, 50, 4, '#FFF8E1', '#FFE082');

        doc.fontSize(10).font('Helvetica-Bold').fillColor(ORANGE)
          .text(`${i + 1}. ${f.title}`, LEFT + 12, actionY + 8, { width: W - 24 });

        if (f.agent_language) {
          doc.fontSize(9).font('Helvetica').fillColor('#555555')
            .text(`"${f.agent_language}"`, LEFT + 12, actionY + 24, { width: W - 24, lineGap: 2 });
        }

        doc.y = Math.max(doc.y, actionY + 50) + 8;
      });

      doc.moveDown(0.5);
    }

    if (okFindings.length > 0) {
      ensureSpace(40);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(GREEN_MID)
        .text('Items Reviewed — No Action Needed', LEFT);
      doc.moveDown(0.5);

      okFindings.forEach((f, i) => {
        ensureSpace(30);
        doc.fontSize(9).font('Helvetica').fillColor('#555555')
          .text(`✓  ${f.title}`, LEFT + 12, doc.y);
        doc.moveDown(0.3);
      });
    }

    // ==================== FOOTER ON EVERY PAGE ====================
    const totalPages = doc.bufferedPageRange();
    // Add footers after all content
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);

      // Footer line
      doc.save()
        .moveTo(LEFT, doc.page.height - 40)
        .lineTo(LEFT + W, doc.page.height - 40)
        .lineWidth(0.5)
        .strokeColor(GRAY_BORDER)
        .stroke()
        .restore();

      // Footer text
      doc.fontSize(7).font('Helvetica').fillColor(GRAY_MID)
        .text('FarmGuard Independent Policy Audit', LEFT, doc.page.height - 32, { width: W * 0.4 });
      doc.fontSize(7).font('Helvetica').fillColor(GRAY_MID)
        .text(`Confidential — Prepared for ${audit.farm_name || 'Customer'}`, LEFT + W * 0.25, doc.page.height - 32, { width: W * 0.5, align: 'center' });
      doc.fontSize(7).font('Helvetica').fillColor(GRAY_MID)
        .text(`Page ${i + 1} of ${range.count}`, LEFT + W * 0.7, doc.page.height - 32, { width: W * 0.3, align: 'right' });
    }

    doc.end();
  });
}
