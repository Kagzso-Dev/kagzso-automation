// Minimal env so `src/env.ts` validates in unit tests that import domain code.
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";
process.env.LINK_SIGNING_SECRET ||= "test-link-secret";
// Unit tests never open a DB connection; these only satisfy env validation.
process.env.DB_HOST ||= "localhost";
process.env.DB_PORT ||= "3306";
process.env.DB_NAME ||= "dispatch_test";
process.env.DB_USER ||= "root";
process.env.DB_PASSWORD ||= "";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.PUBLIC_API_URL ||= "http://localhost:4000";
process.env.EMAIL_FROM ||= "Test <test@example.com>";
process.env.EMAIL_SENDER_ADDRESS ||= "1 Test Way, Testville";
// Tests never start a voice backend process (Settings → Run / switch on), and never pick up this
// machine's own language voice backends from .env (dotenv leaves keys that are already set alone).
process.env.AI_CALL_BACKEND_CONTROL = "false";
for (const code of ["TA", "HI", "KN", "TE", "ML", "MR", "GU", "BN", "PA", "OD"]) {
  process.env[`VOICE_BACKEND_URL_${code}`] ??= "";
  process.env[`VOICE_BACKEND_API_KEY_${code}`] ??= "";
}
