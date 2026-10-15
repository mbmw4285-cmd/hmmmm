// On Render, use this service itself for API requests (same-origin).
// On Netlify or another static host, use the deployed Render backend.
const isRenderHost = window.location.hostname.endsWith('.onrender.com');
window.VERDIX_API_URL = isRenderHost ? '' : 'https://verdix-1.onrender.com';
