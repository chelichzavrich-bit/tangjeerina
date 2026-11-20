// api/pulse.js
// Тонкая обёртка: вся логика пульса в lib/pulse.js.
const { handlePulseRequest } = require('../lib/pulse');
module.exports = (req, res) => handlePulseRequest(req, res);
