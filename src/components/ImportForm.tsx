'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function ImportForm() {
  const [result, setResult] = useState('');
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  function submit(formData: FormData) {
    setResult('');
    startTransition(async () => {
      const payload = Object.fromEntries([...formData.entries()].filter(([,v]) => String(v).trim()));
      const res = await fetch('/api/import', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) setResult(data.error ?? 'The job could not be added. Please check the information and try again.');
      else if (data.excluded) setResult(`The job was saved for reference, but it does not meet your current search preferences. ${data.reasons.join(' ')}`);
      else { setResult(`The job was added and reviewed. Match score: ${data.analysis?.overallFitScore ?? 'still being calculated'}.`); router.refresh(); }
    });
  }
  return <form className="form" action={submit}>
    <div className="field"><label htmlFor="url">Job posting link</label><input id="url" name="url" type="url" required placeholder="https://company.com/careers/job/..."/></div>
    <div className="notice">Start with the job link. The app will try to fill in the details automatically. If the employer&apos;s site does not allow that, copy the missing information into the fields below.</div>
    <div className="field"><label htmlFor="title">Job title</label><input id="title" name="title" placeholder="Only needed if the app cannot read it from the link"/></div>
    <div className="field"><label htmlFor="company">Company</label><input id="company" name="company" placeholder="Only needed if the app cannot read it from the link"/></div>
    <div className="field"><label htmlFor="location">Location</label><input id="location" name="location" placeholder="Atlanta, GA / Dallas, TX / Remote"/></div>
    <div className="field"><label htmlFor="description">Job description</label><textarea id="description" name="description" placeholder="Paste the full job description here if the app cannot read it from the link"/></div>
    <button className="button primary" disabled={pending}>{pending ? 'Reviewing job…' : 'Add and review job'}</button>
    {result && <div className={result.toLowerCase().includes('could not') || result.toLowerCase().includes('does not meet') ? 'notice error' : 'notice'}>{result}</div>}
  </form>;
}
