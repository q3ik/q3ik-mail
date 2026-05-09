import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Q3ik Mail',
  description: 'Email inbox powered by Cloudflare D1',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
