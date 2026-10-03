import type { MetadataRoute } from 'next';

// Android home-screen icon and name (iPhones use app/apple-icon.png).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Eleade Sessions',
    short_name: 'Eleade',
    start_url: '/log',
    display: 'standalone',
    background_color: '#FAFAF8',
    theme_color: '#141414',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
