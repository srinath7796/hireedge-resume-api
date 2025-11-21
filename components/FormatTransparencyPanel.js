import { useMemo, useState } from 'react';
import styles from '../styles/Home.module.css';

const mockMetrics = {
  docx: {
    includeDocument: {
      timings: [
        { label: 'CV Parsing & Validation', ms: 480 },
        { label: 'AI Generation (summary, experience, skills)', ms: 1680 },
        { label: 'Outreach Kit & Highlights', ms: 940 },
        { label: 'DOCX Assembly', ms: 620 },
      ],
      payloadSize: '1.8 MB',
    },
    skipDocument: {
      timings: [
        { label: 'CV Parsing & Validation', ms: 480 },
        { label: 'AI Generation (summary, experience, skills)', ms: 1680 },
        { label: 'Outreach Kit & Highlights', ms: 940 },
      ],
      payloadSize: '420 KB',
    },
  },
  json: {
    includeDocument: {
      timings: [
        { label: 'CV Parsing & Validation', ms: 480 },
        { label: 'AI Generation (summary, experience, skills)', ms: 1680 },
        { label: 'Outreach Kit & Highlights', ms: 940 },
        { label: 'DOCX Assembly', ms: 620 },
        { label: 'Encoding & Packaging', ms: 320 },
      ],
      payloadSize: '2.4 MB',
    },
    skipDocument: {
      timings: [
        { label: 'CV Parsing & Validation', ms: 480 },
        { label: 'AI Generation (summary, experience, skills)', ms: 1680 },
        { label: 'Outreach Kit & Highlights', ms: 940 },
      ],
      payloadSize: '310 KB',
    },
  },
};

const pillStyle = (isActive) => ({
  padding: '10px 18px',
  borderRadius: '999px',
  border: 'none',
  cursor: 'pointer',
  fontWeight: 600,
  background: isActive ? 'rgba(59, 130, 246, 0.18)' : 'rgba(148, 163, 184, 0.16)',
  color: isActive ? '#1d4ed8' : '#475569',
  transition: 'all 0.2s ease',
});

export function FormatTransparencyPanel() {
  const [format, setFormat] = useState('docx');
  const [includeDocument, setIncludeDocument] = useState(true);

  const metrics = useMemo(
    () => mockMetrics[format][includeDocument ? 'includeDocument' : 'skipDocument'],
    [format, includeDocument],
  );

  const modeLabel = format === 'docx' ? 'Downloadable DOCX' : 'Insights JSON';

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Format Selector & Transparency</h2>
          <p>
            Reflect the API’s response preferences on the website so prospects choose
            instant downloads or analytics-ready JSON. Share the build timeline to prove
            HireEdge’s reliability.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="button" style={pillStyle(format === 'docx')} onClick={() => setFormat('docx')}>
              DOCX Download
            </button>
            <button type="button" style={pillStyle(format === 'json')} onClick={() => setFormat('json')}>
              JSON Insights
            </button>
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: 'rgba(148, 163, 184, 0.18)',
              padding: '10px 16px',
              borderRadius: '16px',
              fontWeight: 600,
              color: '#0f172a',
            }}
          >
            <input
              type="checkbox"
              checked={includeDocument}
              onChange={() => setIncludeDocument((prev) => !prev)}
              style={{ width: '18px', height: '18px' }}
            />
            Include document build
          </label>
        </div>
      </div>

      <div className={styles.row}>
        <div
          style={{
            background: 'rgba(15, 23, 42, 0.92)',
            borderRadius: '22px',
            padding: '24px',
            color: '#f1f5f9',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <span style={{ opacity: 0.7, letterSpacing: '0.6px', textTransform: 'uppercase' }}>Selected mode</span>
          <strong style={{ fontSize: '1.4rem' }}>{modeLabel}</strong>
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            Payload size: <strong>{metrics.payloadSize}</strong>
          </p>
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            Perfect for {format === 'docx' ? 'job seekers who want instant downloads.' : 'ATS tracking, analytics, and CRM integrations.'}
          </p>
        </div>

        <div
          style={{
            background: 'rgba(248, 250, 252, 0.96)',
            borderRadius: '22px',
            padding: '24px',
            border: '1px solid rgba(148, 163, 184, 0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          <h3 style={{ margin: 0, color: '#0f172a' }}>How this résumé was crafted</h3>
          <ol style={{ margin: 0, paddingLeft: '20px', color: '#1f2937', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {metrics.timings.map((step) => (
              <li key={step.label} style={{ lineHeight: 1.6 }}>
                <strong>{step.label}:</strong> {step.ms} ms
              </li>
            ))}
          </ol>
          <p style={{ margin: 0, fontSize: '0.95rem', color: '#475569' }}>
            Mirror this timeline in a modal or tooltip so customers trust the AI flow
            and see the speed difference when skipping DOCX generation.
          </p>
        </div>
      </div>
    </section>
  );
}
