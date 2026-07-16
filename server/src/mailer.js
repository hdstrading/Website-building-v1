/* ==========================================================================
 * mailer.js — optional email sending (SMTP via nodemailer)
 * --------------------------------------------------------------------------
 * Configured through env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
 * SMTP_FROM, SMTP_SECURE). If SMTP_HOST is not set, email features degrade
 * gracefully: calls succeed but simply log that mail was skipped.
 * ========================================================================== */
'use strict';
const nodemailer = require('nodemailer');

let transporter = null;
function configured() { return !!process.env.SMTP_HOST; }

function getTransport() {
  if (!configured()) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: port,
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
  return transporter;
}

async function sendMail(opts) {
  const t = getTransport();
  if (!t) {
    console.log('[mail skipped — SMTP not configured]', opts.subject, '->', opts.to);
    return { skipped: true };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@ph-payroll';
  return t.sendMail({ from: from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text });
}

module.exports = { configured, sendMail };
