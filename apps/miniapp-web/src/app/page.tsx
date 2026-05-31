import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function HomePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}): never {
  const tg = typeof searchParams['tg'] === 'string' ? searchParams['tg'] : '';
  redirect(tg ? `/onboard?tg=${encodeURIComponent(tg)}` : '/onboard');
}
