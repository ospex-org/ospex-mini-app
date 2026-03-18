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
        <link
          href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap"
          rel="stylesheet"
        />
        <style dangerouslySetInnerHTML={{ __html: `
          *, *::before, *::after { box-sizing: border-box; }
          button, a { max-width: 100%; }
        ` }} />
      </head>
      <body style={{
        margin: 0,
        padding: '16px',
        fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif",
        backgroundColor: '#0a0a0a',
        color: '#f2f2f2',
        minHeight: '100vh',
      }}>
        {children}
      </body>
    </html>
  );
}
