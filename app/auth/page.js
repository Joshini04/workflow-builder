'use client';

import { useState } from 'react';
import { useSignUpEmailPassword, useSignInEmailPassword } from '@nhost/react';
import { useRouter } from 'next/navigation';

export default function AuthPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState('signin');
  const router = useRouter();

  const { signUpEmailPassword, isLoading: signUpLoading, isError: signUpError, error: signUpErrorMsg } = useSignUpEmailPassword();
  const { signInEmailPassword, isLoading: signInLoading, isError: signInError, error: signInErrorMsg } = useSignInEmailPassword();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (mode === 'signup') {
      const result = await signUpEmailPassword(email, password);
      console.log('Signup result:', result);
      if (result.isSuccess) {
        router.push('/');
      } else {
        alert('Signed up, but email verification may be required before signing in.');
      }
    } else {
      const result = await signInEmailPassword(email, password);
      console.log('Signin result:', result);
      if (result.isSuccess) router.push('/');
    }
  };

  const isLoading = signUpLoading || signInLoading;
  const error = signUpError || signInError;
  const errorMsg = signUpErrorMsg || signInErrorMsg;

  return (
    <main style={{ padding: 40, maxWidth: 400, margin: '0 auto' }}>
      <h1>{mode === 'signup' ? 'Sign Up' : 'Sign In'}</h1>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: 10, fontSize: 16 }}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{ padding: 10, fontSize: 16 }}
        />
        <button type="submit" disabled={isLoading} style={{ padding: 10, fontSize: 16 }}>
          {isLoading ? 'Loading...' : mode === 'signup' ? 'Sign Up' : 'Sign In'}
        </button>
      </form>

      {error && <p style={{ color: 'red' }}>{errorMsg?.message}</p>}

      <button
        onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}
        style={{ marginTop: 16, background: 'none', border: 'none', color: 'blue', cursor: 'pointer' }}
      >
        {mode === 'signup' ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
      </button>
    </main>
  );
}