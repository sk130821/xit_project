import nodemailer from 'nodemailer';

function getMailConfig() {
  return {
    host: process.env.SMTP_HOST || 'mail.xittoken.co',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: {
      user: process.env.SMTP_USER || 'support@xittoken.co',
      pass: process.env.SMTP_PASS || '',
    },
  };
}

function getFromAddress() {
  const name = process.env.MAIL_FROM_NAME || 'XIT Token Support';
  const email = process.env.MAIL_FROM || process.env.SMTP_USER || 'support@xittoken.co';
  return `"${name}" <${email}>`;
}

let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport(getMailConfig());
  }
  return transporter;
}

export async function sendPasswordResetEmail({ toEmail, username, resetUrl }) {
  if (!process.env.SMTP_PASS) {
    throw new Error('SMTP is not configured on the server (SMTP_PASS missing)');
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="color:#d4a017">XIT Token — Password Reset</h2>
      <p>Hi ${username || 'there'},</p>
      <p>We received a request to reset your password. Click the button below (link expires in 1 hour):</p>
      <p style="text-align:center;margin:28px 0">
        <a href="${resetUrl}" style="background:linear-gradient(90deg,#f3ba2f,#c9940e);color:#000;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;display:inline-block">Reset Password</a>
      </p>
      <p style="font-size:13px;color:#555">If the button does not work, copy this link:</p>
      <p style="font-size:12px;word-break:break-all;color:#333">${resetUrl}</p>
      <p style="font-size:13px;color:#777;margin-top:24px">If you did not request this, ignore this email. Your password will stay the same.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
      <p style="font-size:12px;color:#999">XIT Token · support@xittoken.co</p>
    </div>
  `;

  await getTransporter().sendMail({
    from: getFromAddress(),
    to: toEmail,
    replyTo: process.env.MAIL_REPLY_TO || 'support@xittoken.co',
    subject: 'Reset your XIT Token password',
    html,
    text: `Reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you did not request this, ignore this email.`,
  });
}
