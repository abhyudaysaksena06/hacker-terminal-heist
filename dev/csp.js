// Content-Security-Policy for the built frontend. Same rules as the old Express server, plus the Supabase
// project as the one API host. frame-ancestors cannot be set from a <meta> tag: set it as a header on your host.
export function csp(supabaseUrl) {
  const api = supabaseUrl ? ' ' + new URL(supabaseUrl).origin : '';
  return ["default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
    "img-src 'self' data:", `connect-src 'self'${api}`, "base-uri 'none'", "form-action 'self'"].join('; ');
}
