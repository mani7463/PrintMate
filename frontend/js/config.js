/**
 * PrintMate Client Configuration
 * Allows frontend on Vercel to communicate with backend on Render in real time.
 */

// Check query param (?backend=https://...) or localStorage for custom live deployment
const urlParams = new URLSearchParams(window.location.search);
const queryBackend = urlParams.get('backend');
if (queryBackend) {
  localStorage.setItem('PRINTMATE_BACKEND', queryBackend);
}
const savedBackend = localStorage.getItem('PRINTMATE_BACKEND');

window.PRINTMATE_CONFIG = {
  // Production Render Backend URL (Update this with your deployed Render service URL)
  BACKEND_URL: savedBackend || (
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ? 'http://localhost:3000'
      : 'https://printmate-wccb.onrender.com'
  )
};

console.log('🔗 PrintMate Backend configured to:', window.PRINTMATE_CONFIG.BACKEND_URL);
