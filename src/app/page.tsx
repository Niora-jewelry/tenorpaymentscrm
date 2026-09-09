import { redirect } from 'next/navigation';

/**
 * The root has no content of its own. Middleware decides what happens:
 * a signed-in visitor reaches /dashboard, anyone else is sent to /login with
 * their destination preserved.
 */
export default function Home() {
  redirect('/dashboard');
}
