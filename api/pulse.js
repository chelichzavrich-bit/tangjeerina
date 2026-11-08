const { handlePulseRequest } = require('../lib/pulse');

module.exports = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    return handlePulseRequest(req, res);
};
