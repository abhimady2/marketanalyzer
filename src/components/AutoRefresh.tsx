'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Re-renders the server page on an interval so the verdict updates without a full
// reload. The server read is cache-backed, so this is cheap.
export default function AutoRefresh({ seconds = 120 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
