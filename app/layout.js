'use client';

import { NhostProvider } from '@nhost/react';
import { NhostApolloProvider } from '@nhost/react-apollo';import { nhost } from '@/lib/nhost';
import './globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <NhostProvider nhost={nhost}>
          <NhostApolloProvider nhost={nhost}>
            {children}
          </NhostApolloProvider>
        </NhostProvider>
      </body>
    </html>
  );
}