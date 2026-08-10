'use client';

import { useAuthenticationStatus, useUserData, useSignOut } from '@nhost/react';
import Link from 'next/link';

export default function Home() {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const user = useUserData();
  const { signOut } = useSignOut();

  if (isLoading) return <p>Loading...</p>;

  return (
    <main style={{ padding: 40 }}>
      <h1>Workflow Builder</h1>
      {isAuthenticated ? (
        <>
          <p>Logged in as: {user?.email}</p>
          <button onClick={signOut}>Sign Out</button>
        </>
      ) : (
        <Link href="/auth">Sign In / Sign Up</Link>
      )}
    </main>
  );
}