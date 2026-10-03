import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { Shell } from '@/components/Shell';
import '@fontsource-variable/league-spartan';
import './globals.css';

export const metadata: Metadata = {
  title: 'Eleade Sessions',
  description: 'Session logging, player credits and coach pay for Eleade.',
  appleWebApp: { capable: true, title: 'Eleade', statusBarStyle: 'black' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#141414' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body>
        <AuthProvider>
          <Shell>{children}</Shell>
        </AuthProvider>
      </body>
    </html>
  );
}
