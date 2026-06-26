export default function handler(req, res) {
  res.status(200).json({
    DATA_SUPABASE_URL: process.env.DATA_SUPABASE_URL,
    DATA_SUPABASE_KEY: process.env.DATA_SUPABASE_KEY,
    APP_SUPABASE_URL: process.env.APP_SUPABASE_URL,
    APP_SUPABASE_KEY: process.env.APP_SUPABASE_KEY
  });
}
