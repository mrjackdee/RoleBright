import { NextRequest, NextResponse } from 'next/server';
import { validSessionToken } from '@/lib/auth';

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (process.env.APP_ENV === 'staging' && (pathname.startsWith('/api/cron') || pathname.startsWith('/api/auth/google'))) {
    return NextResponse.json({ error: 'This integration is disabled in isolated staging.' }, { status: 503 });
  }
  if (pathname.startsWith('/_next') || pathname === '/favicon.ico' || pathname === '/login' || pathname.startsWith('/api/auth/google') || pathname.startsWith('/api/health') || pathname.startsWith('/api/cron')) return NextResponse.next();
  if (process.env.NODE_ENV !== 'production' && !process.env.APP_SESSION_SECRET) return NextResponse.next();
  const valid = await validSessionToken(request.cookies.get('jd_session')?.value, process.env.APP_SESSION_SECRET);
  if (valid) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Your sign-in session has ended. Sign in again, then retry this action.' }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  return NextResponse.redirect(url);
}
export const config = { matcher: ['/((?!_next/static|_next/image).*)'] };
