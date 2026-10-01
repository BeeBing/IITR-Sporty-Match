'use strict';

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PURPOSE = {
  login: { action: 'log in', subject: 'login code' },
  verify: { action: 'verify your email', subject: 'verification code' },
  reset: { action: 'reset your password', subject: 'password reset code' },
};

// One-time code email. The subject starts with the code so it shows in phone notifications.
function codeEmail({ name, code, purpose, ttlMin }) {
  const p = PURPOSE[purpose];
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const subject = `${code} is your IITR Sporty Match ${p.subject}`;
  const text = [
    `Hi ${first},`,
    '',
    `Use ${code} to ${p.action}. It expires in ${ttlMin} minutes.`,
    '',
    "If this wasn't you, ignore this email — nobody can get in without the code.",
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f2;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#15201a">
<div style="max-width:440px;margin:0 auto;padding:28px 20px">
  <p style="margin:0 0 18px;font-size:17px;font-weight:700;color:#0f6b43">IITR Sporty Match</p>
  <div style="background:#fff;border:1px solid #dde3db;border-radius:14px;padding:24px">
    <p style="margin:0 0 12px">Hi ${escape(first)},</p>
    <p style="margin:0 0 16px">Use this code to ${p.action}:</p>
    <p style="margin:0 0 16px;font-size:34px;font-weight:800;letter-spacing:8px;text-align:center;color:#0a5333">${code}</p>
    <p style="margin:0;color:#5b6a61;font-size:14px">It expires in ${ttlMin} minutes. If this wasn't you, ignore this email — nobody can get in without the code.</p>
  </div>
</div></body></html>`;
  return { subject, text, html };
}

module.exports = { codeEmail };
