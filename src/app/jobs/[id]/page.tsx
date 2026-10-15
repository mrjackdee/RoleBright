import { notFound } from 'next/navigation';
import { getState } from '@/lib/storage/state';
import { salaryText } from '@/lib/utils';
import { JobActions } from '@/components/JobActions';
export const dynamic = 'force-dynamic';
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = await getState();
  const job = state.jobs.find(j=>j.id===id); if (!job) notFound();
  const analysis = state.analyses.filter(a=>a.jobId===id).sort((a,b)=>b.analysisDate.localeCompare(a.analysisDate))[0];
  const packages = state.applicationPackages.filter(p=>p.jobId===id).sort((a,b)=>b.version-a.version);
  const application = state.applications.find(a=>a.jobId===id);
  return <>
    <section className="hero"><div className="eyebrow">{job.company}</div><h1>{job.title}</h1><p>{job.location} · {friendlyWorkStyle(job.workArrangement)} · {salaryText(job.salaryMin,job.salaryMax)}</p><div className="hero-actions"><a className="button primary" href={job.applicationUrl} target="_blank" rel="noreferrer">View employer&apos;s job posting</a>{packages[0]?.googleDriveFolderUrl&&<a className="button" href={packages[0].googleDriveFolderUrl} target="_blank" rel="noreferrer">Open saved application materials</a>}</div></section>
    <div className="detail-layout"><div style={{display:'grid',gap:14}}>
      {analysis?<section className="panel"><h2>How well this job matches you</h2><div className="stats" style={{margin:'0 0 12px'}}><div className="stat"><div className="stat-value">{analysis.overallFitScore}</div><div className="stat-label">Overall job match</div></div><div className="stat"><div className="stat-value">{analysis.atsScore}</div><div className="stat-label">Resume match before tailoring</div></div><div className="stat"><div className="stat-value">{analysis.priorityScore}</div><div className="stat-label">How soon to review</div></div><div className="stat"><div className="stat-value" style={{fontSize:17}}>{friendlyRisk(analysis.overqualificationRisk)}</div><div className="stat-label">Risk of appearing overqualified</div></div></div><h3>Why this job may be a good fit</h3><ul>{analysis.strengths.map(x=><li key={x}>{x}</li>)}</ul><h3>Things to think about before applying</h3><ul>{analysis.gaps.length?analysis.gaps.map(x=><li key={x}>{x}</li>):<li>No important gaps were found in the current review.</li>}</ul><h3>Suggested approach</h3><p className="fit">{analysis.recommendedApplicationStrategy}</p></section>:<div className="notice">This job has not been reviewed against your Career Profile yet.</div>}
      <section className="panel"><h2>Job description</h2><div className="prose">{job.description}</div></section>
    </div><aside style={{display:'grid',gap:14}}>
      <JobActions jobId={job.id} packages={packages} currentStatus={application?.status}/>
      <section className="panel"><h2>Job details</h2><div className="kv"><div className="kv-row"><div className="kv-key">Listing status</div><div>{friendlyVerification(job.verificationStatus)}</div></div><div className="kv-row"><div className="kv-key">Where it came from</div><div>{job.source}</div></div><div className="kv-row"><div className="kv-key">Posted</div><div>{job.datePosted?new Date(job.datePosted).toLocaleDateString():'Not listed'}</div></div><div className="kv-row"><div className="kv-key">Added to your app</div><div>{new Date(job.dateDiscovered).toLocaleDateString()}</div></div><div className="kv-row"><div className="kv-key">Appears reposted</div><div>{job.repost?'Yes':'No'}</div></div><div className="kv-row"><div className="kv-key">Best resume to start from</div><div>{analysis?.recommendedMasterResume??'Not decided yet'}</div></div></div></section>
      <section className="panel"><h2>Saved application materials</h2>{packages.length?packages.map(p=><div key={p.id} style={{borderTop:'1px solid var(--navy-700)',padding:'10px 0'}}><strong>Version {p.version}</strong> · <span className={`badge ${p.qaStatus==='PASSED'?'good':'danger'}`}>{p.qaStatus==='PASSED'?'READY':'NEEDS REVIEW'}</span><div className="fit">Resume match improved from {p.atsScoreBefore} to {p.atsScoreAfter}</div><div className="hero-actions" style={{marginTop:8}}>{p.resumeUrl&&<a className="button" href={p.resumeUrl} target="_blank" rel="noreferrer">Resume</a>}{p.coverLetterUrl&&<a className="button" href={p.coverLetterUrl} target="_blank" rel="noreferrer">Cover letter</a>}{p.analysisUrl&&<a className="button" href={p.analysisUrl} target="_blank" rel="noreferrer">Match review</a>}</div></div>):<p className="fit">No application materials have been prepared yet.</p>}</section>
    </aside></div>
  </>;
}

function friendlyWorkStyle(value: string) { return value === 'REMOTE' ? 'Remote' : value === 'HYBRID' ? 'Hybrid' : value === 'ONSITE' ? 'On-site' : 'Work style not listed'; }
function friendlyRisk(value: string) { return value === 'HIGH' ? 'High' : value === 'MEDIUM' ? 'Medium' : 'Low'; }
function friendlyVerification(value: string) { return value === 'ACTIVE_VERIFIED' ? 'Active' : value === 'ACTIVE_LIKELY' ? 'Likely active' : value === 'INACTIVE' ? 'No longer active' : 'Needs confirmation'; }
