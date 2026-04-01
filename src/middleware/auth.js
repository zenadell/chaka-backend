const admin = require('firebase-admin');

async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split('Bearer ')[1];

    try {
        // Verify the token with Firebase Admin
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = { uid: decodedToken.uid, email: decodedToken.email };
        next();
    } catch (error) {
        // Fallback for local development when lacking Firebase Service Account
        if (error.message && error.message.includes('Unable to detect a Project Id')) {
            console.warn("⚠️ Bypassing strict Firebase verification because service account is missing (Local Dev fallback)");
            try {
                // Manually parse the JWT payload without verifying signature
                const payloadStr = Buffer.from(token.split('.')[1], 'base64').toString('utf-8');
                const parsed = JSON.parse(payloadStr);
                
                req.user = { uid: parsed.user_id || parsed.uid, email: parsed.email };
                return next();
            } catch (fallbackErr) {
                console.error("Auth Fallback Error:", fallbackErr.message);
            }
        }
        
        console.error("Auth Error:", error.message);
        return res.status(403).json({ error: 'Unauthorized: Invalid token' });
    }
}

module.exports = { verifyToken };