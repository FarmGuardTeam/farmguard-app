// Vercel Serverless Function: Send Email via Resend
// Sends transactional emails (thank-you after payment, report ready, etc.)
// Uses Resend API (https://resend.com) — free tier: 100 emails/month

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: 'Email service not configured.' });
  }

  const { to, type, audit } = req.body;

  if (!to || !type) {
    return res.status(400).json({ error: 'Missing required fields: to, type' });
  }

  try {
    let subject, html;

    if (type === 'payment_confirmation') {
      subject = `Your FarmGuard Report is Ready — ${audit?.farm_name || 'Policy Audit'}`;
      html = buildPaymentConfirmationEmail(audit);
    } else if (type === 'report_ready') {
      subject = `Your FarmGuard Audit is Complete — ${audit?.farm_name || 'Policy Audit'}`;
      html = buildReportReadyEmail(audit);
    } else {
      return res.status(400).json({ error: 'Unknown email type: ' + type });
    }

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'FarmGuard <noreply@farmguardaudit.com>',
        to: [to],
        subject: subject,
        html: html
      })
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('Resend API error:', errText);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    const result = await emailRes.json();
    return res.status(200).json({ success: true, email_id: result.id });

  } catch (err) {
    console.error('Email error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ===================== EMAIL TEMPLATES =====================

function buildPaymentConfirmationEmail(audit) {
  const reportUrl = `https://www.farmguardaudit.com/report.html?audit=${audit?.id || ''}`;
  const farmName = audit?.farm_name || 'your farm';
  const auditId = audit?.audit_id || '';
  const savings = audit?.savings_found ? `$${Number(audit.savings_found).toLocaleString()}` : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f5f5f0; font-family:Arial, Helvetica, sans-serif;">
  <div style="max-width:600px; margin:0 auto; background:#ffffff;">

    <!-- Header -->
    <div style="background:#2D5016; padding:24px 32px;">
      <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:bold;">FarmGuard</h1>
      <p style="margin:4px 0 0; color:#A8C88A; font-size:12px; letter-spacing:1px;">INDEPENDENT POLICY AUDIT</p>
    </div>

    <!-- Main Content -->
    <div style="padding:32px;">

      <h2 style="color:#2D5016; font-size:20px; margin:0 0 8px;">Thank You for Choosing FarmGuard!</h2>

      <p style="color:#555555; font-size:15px; line-height:1.6; margin:0 0 16px;">
        Your Policy Clarity Audit for <strong>${farmName}</strong> is now complete and your full report is ready to view.
      </p>

      ${savings ? `
      <div style="background:#F0F7EC; border-left:4px solid #4A7C23; padding:16px 20px; margin:0 0 20px; border-radius:0 6px 6px 0;">
        <p style="margin:0; color:#2D5016; font-size:14px;">
          <strong>Estimated Total Impact:</strong>
          <span style="font-size:22px; font-weight:bold; color:#2D5016; display:block; margin-top:4px;">${savings}</span>
        </p>
      </div>
      ` : ''}

      <p style="color:#555555; font-size:15px; line-height:1.6; margin:0 0 20px;">
        Your report includes detailed findings, dollar impact estimates for each issue, and <strong>word-for-word scripts</strong> you can use when talking to your insurance agent.
      </p>

      <!-- CTA Button -->
      <div style="text-align:center; margin:24px 0;">
        <a href="${reportUrl}" style="display:inline-block; background:#4A7C23; color:#ffffff; text-decoration:none; padding:14px 40px; border-radius:6px; font-size:16px; font-weight:bold;">
          View Your Full Report
        </a>
      </div>

      <p style="color:#888888; font-size:13px; text-align:center; margin:0 0 24px;">
        Report ID: ${auditId}
      </p>

      <!-- Divider -->
      <hr style="border:none; border-top:1px solid #E0E0E0; margin:24px 0;">

      <!-- Referral Section -->
      <div style="background:#FFFBF0; border:1px solid #F0E6C8; border-radius:8px; padding:20px; text-align:center;">
        <p style="margin:0 0 4px; color:#8B6914; font-size:13px; font-weight:bold; letter-spacing:0.5px;">SHARE WITH A FRIEND</p>
        <p style="margin:0 0 12px; color:#555555; font-size:14px; line-height:1.5;">
          Know a fellow farmer who could benefit from an independent policy audit?<br>
          Give them <strong>$5 off</strong> their first audit with this code:
        </p>
        <div style="display:inline-block; background:#ffffff; border:2px dashed #D4A843; padding:10px 28px; border-radius:6px;">
          <span style="font-size:24px; font-weight:bold; color:#2D5016; letter-spacing:2px;">FRIEND5</span>
        </div>
        <p style="margin:12px 0 0; color:#888888; font-size:12px;">
          They save $5, and you help protect a neighbor's operation.
        </p>
      </div>

      <!-- Divider -->
      <hr style="border:none; border-top:1px solid #E0E0E0; margin:24px 0;">

      <p style="color:#555555; font-size:14px; line-height:1.6; margin:0 0 8px;">
        <strong>What to do next:</strong>
      </p>
      <p style="color:#555555; font-size:14px; line-height:1.6; margin:0 0 4px;">
        1. Review your report and the detailed findings
      </p>
      <p style="color:#555555; font-size:14px; line-height:1.6; margin:0 0 4px;">
        2. Print or download the PDF version to take to your agent
      </p>
      <p style="color:#555555; font-size:14px; line-height:1.6; margin:0 0 16px;">
        3. Use the "Tell Your Agent" scripts for each finding — they're written for you word-for-word
      </p>

      <p style="color:#888888; font-size:13px; line-height:1.5; margin:0;">
        Questions? Reply to this email or reach us at <a href="mailto:support@farmguardaudit.com" style="color:#4A7C23;">support@farmguardaudit.com</a>
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#F5F5F0; padding:20px 32px; border-top:1px solid #E0E0E0;">
      <p style="margin:0; color:#888888; font-size:12px; text-align:center;">
        FarmGuard &mdash; Independent Crop Insurance Policy Audits<br>
        <a href="https://www.farmguardaudit.com" style="color:#4A7C23;">farmguardaudit.com</a>
      </p>
      <p style="margin:8px 0 0; color:#AAAAAA; font-size:11px; text-align:center;">
        This report is for informational purposes only and does not constitute insurance advice.
      </p>
    </div>

  </div>
</body>
</html>`;
}

function buildReportReadyEmail(audit) {
  const reportUrl = `https://www.farmguardaudit.com/report.html?audit=${audit?.id || ''}`;
  const farmName = audit?.farm_name || 'your farm';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f5f5f0; font-family:Arial, Helvetica, sans-serif;">
  <div style="max-width:600px; margin:0 auto; background:#ffffff;">

    <div style="background:#2D5016; padding:24px 32px;">
      <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:bold;">FarmGuard</h1>
      <p style="margin:4px 0 0; color:#A8C88A; font-size:12px; letter-spacing:1px;">INDEPENDENT POLICY AUDIT</p>
    </div>

    <div style="padding:32px;">
      <h2 style="color:#2D5016; font-size:20px; margin:0 0 8px;">Your Audit Report is Ready!</h2>

      <p style="color:#555555; font-size:15px; line-height:1.6; margin:0 0 16px;">
        Great news! Our review of your crop insurance policy for <strong>${farmName}</strong> is complete. Your report is ready for you to unlock and view.
      </p>

      <p style="color:#555555; font-size:15px; line-height:1.6; margin:0 0 20px;">
        Your report includes detailed findings with dollar estimates, annotated policy documents, and agent-ready action plans you can take directly to your insurance agent.
      </p>

      <div style="text-align:center; margin:24px 0;">
        <a href="${reportUrl}" style="display:inline-block; background:#D4A843; color:#ffffff; text-decoration:none; padding:14px 40px; border-radius:6px; font-size:16px; font-weight:bold;">
          View & Unlock Your Report — $29.99
        </a>
      </div>

      <p style="color:#888888; font-size:13px; text-align:center; margin:0;">
        One-time payment. No subscription.
      </p>
    </div>

    <div style="background:#F5F5F0; padding:20px 32px; border-top:1px solid #E0E0E0;">
      <p style="margin:0; color:#888888; font-size:12px; text-align:center;">
        FarmGuard &mdash; Independent Crop Insurance Policy Audits<br>
        <a href="https://www.farmguardaudit.com" style="color:#4A7C23;">farmguardaudit.com</a>
      </p>
    </div>

  </div>
</body>
</html>`;
}
