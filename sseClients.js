// Shared in-memory SSE client registry
// Map<idempotency_key, express.Response[]>
const sseClients = new Map();

module.exports = sseClients;
