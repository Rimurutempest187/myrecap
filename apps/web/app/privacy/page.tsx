import { SiteHeader, SiteFooter } from '@/components/site-header';
export const metadata = { title: 'Privacy Policy' };
export default function Privacy() {
  return (
    <>
      <SiteHeader />
      <main className="max-w-3xl mx-auto px-4 py-16 space-y-5 text-sm leading-7">
        <h1 className="text-3xl font-bold">Privacy Policy</h1>
        <p>We store your account details (name, email, hashed password), your uploaded videos, generated audio, subtitles and rendered videos in private storage. Files are only accessible through short-lived signed links issued to you.</p>
        <p>To generate recaps, sampled video frames and text are sent to our configured AI providers (an LLM/vision API and Microsoft Azure Speech for Myanmar voiceover). Payment details are handled by Stripe; we never see your card number.</p>
        <p>Temporary processing files are deleted automatically after each job. Deleting a project removes its files; deleting your account removes all of your data.</p>
      </main>
      <SiteFooter />
    </>
  );
}
