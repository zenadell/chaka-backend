const nodemailer = require('nodemailer');

async function sendEmail(recipient, subject, body, credentials) {
    // 1. Parse Credentials
    // Format expected from Admin: "your_chaka_gmail@gmail.com:xxxx-xxxx-xxxx-xxxx"
    // (We are splitting by ':' just like before)
    const [user, pass] = credentials.split(':');

    if (!user || !pass) {
        throw new Error("Invalid Credentials. check Admin Panel. Format: 'email:app_password'");
    }

        // 2. Configure Gmail SMTP (FIXED for Render)
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,      // ⚠️ CHANGED: Port 587 is safer for Cloud Servers
        secure: false,  // ⚠️ CHANGED: Must be false for 587 (STARTTLS)
        auth: {
            user: user,
            pass: pass
        },
        tls: {
            rejectUnauthorized: true
        },
        family: 4       // Keep IPv4 forcing
    });

    // 3. Handle Multiple Recipients (Privacy Fix)
    // This logic is perfect. It ensures users don't see each other on CC.
    const recipients = recipient.split(',').map(email => email.trim()).filter(email => email);

    if (recipients.length === 0) {
        throw new Error("No valid recipients provided.");
    }

    // 4. Helper function to send one email
    const sendToSingleRecipient = async (singleTo) => {
        const mailOptions = {
            from: `\"Chaka AI\" <${user}>`, // Shows "Chaka AI" as sender
            to: singleTo,
            subject: subject,
            text: body,
            html: body.replace(/\n/g, '<br>') // Convert Chaka's newlines to HTML
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            console.log(`✅ Email sent to ${singleTo}: ${info.messageId}`);
            return info.messageId;
        } catch (error) {
            console.error(`❌ Failed to send to ${singleTo}:`, error);
            return null;
        }
    };

    // 5. Send to everyone individually
    // This runs them all in parallel.
    const results = await Promise.all(recipients.map(r => sendToSingleRecipient(r)));

    // 6. Report Results
    const successCount = results.filter(id => id !== null).length;

    if (successCount === 0) {
        throw new Error("Failed to send email. Check your Gmail App Password in Admin.");
    }

    return `Successfully delivered to ${successCount} recipient(s).`;
}

module.exports = { sendEmail };
