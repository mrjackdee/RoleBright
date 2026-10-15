import type { Metadata, Viewport } from 'next';
import { Inter, Playfair_Display } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';
import './ux.css';
import { Header } from '@/components/Header';
import { Nav } from '@/components/Nav';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const playfair = Playfair_Display({ subsets: ['latin'], variable: '--font-playfair', display: 'swap' });

export const metadata: Metadata = {
  title: 'Jack Dee Job Search Command Center',
  description: 'Personal career operating system for job discovery, fit analysis, ATS optimization and application tracking.'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0A192F'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable}`}>
      <body>
        <div className="shell">
          <Header/>
          <main className="main">{children}</main>
          <div className="mobile-nav"><Nav/></div>
        </div>
        {process.env.APP_ENV !== 'staging' && <Analytics />}
      </body>
    </html>
  );
}
