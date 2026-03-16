import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Ospex Wallet Setup',
  description: 'Create your Ospex betting wallet',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Telegram Web Apps SDK - must be loaded before the app */}
        <script src="https://telegram.org/js/telegram-web-app.js" />
      </head>
      <body style={{
        margin: 0,
        padding: '16px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        backgroundColor: 'var(--tg-theme-bg-color, #1a1a2e)',
        color: 'var(--tg-theme-text-color, #ffffff)',
        minHeight: '100vh',
      }}>
        {children}
      </body>
    </html>
  );
}
