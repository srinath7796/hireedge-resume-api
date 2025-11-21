import { useMemo, useState } from 'react';
import styles from '../styles/Home.module.css';

const tracks = [
  {
    id: 'upload',
    label: 'Upload a document',
    summary: 'Best for polished CVs that already have structure and sections.',
    steps: [
      {
        title: 'Choose your file',
        detail: 'DOCX, PDF, and TXT up to 8 MB. We flag scanned PDFs and suggest OCR when needed.',
      },
      {
        title: 'Instant text verification',
        detail: 'We extract your CV text, surface what was captured, and highlight missing sections before generating.',
      },
      {
        title: 'Smart clean-up',
        detail: 'Temporary uploads are deleted after parsing to keep candidate data safe.',
      },
    ],
    tip: 'Use this when you have a designer CV but want HireEdge to reformat it for ATS compatibility.',
  },
  {
    id: 'paste',
    label: 'Paste your CV text',
    summary: 'Perfect for quick experiments or capturing notes from a recent role.',
    steps: [
      {
        title: 'Structured editor',
        detail: 'Paste plain text and we auto-detect sections like summary, experience, projects, and skills.',
      },
      {
        title: 'JD pairing',
        detail: 'Drop in a job description to immediately see matched and missing keywords in the preview.',
      },
      {
        title: 'Format preview',
        detail: 'Decide between JSON insights or DOCX download before sending content to OpenAI.',
      },
    ],
    tip: 'Use this when you’re iterating fast or updating a CV between interviews.',
  },
];

export function OnboardingStepper() {
  const [activeTrack, setActiveTrack] = useState('upload');

  const track = useMemo(() => tracks.find((item) => item.id === activeTrack), [activeTrack]);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Guided Onboarding</h2>
          <p>
            Help users choose between uploading a file or pasting text. A guided stepper
            reduces failed submissions and educates candidates on HireEdge’s safeguards
            before they press generate.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {tracks.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTrack(item.id)}
              style={{
                border: 'none',
                cursor: 'pointer',
                borderRadius: '16px',
                padding: '10px 18px',
                fontWeight: 600,
                color: activeTrack === item.id ? '#f8fafc' : '#0f172a',
                background:
                  activeTrack === item.id
                    ? 'linear-gradient(135deg, #0ea5e9, #22d3ee)'
                    : 'rgba(14, 116, 144, 0.16)',
                boxShadow:
                  activeTrack === item.id
                    ? '0 12px 30px rgba(14, 116, 144, 0.28)'
                    : 'none',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.row}>
        <div
          style={{
            background: '#0f172a',
            color: '#f8fafc',
            borderRadius: '22px',
            padding: '28px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          <div>
            <h3 style={{ margin: '0 0 8px' }}>{track.label}</h3>
            <p style={{ margin: 0, opacity: 0.8 }}>{track.summary}</p>
          </div>
          <ol style={{ margin: 0, paddingLeft: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {track.steps.map((step) => (
              <li key={step.title} style={{ lineHeight: 1.6 }}>
                <strong>{step.title}</strong>
                <br />
                <span style={{ opacity: 0.85 }}>{step.detail}</span>
              </li>
            ))}
          </ol>
        </div>

        <div
          style={{
            background: 'rgba(20, 184, 166, 0.12)',
            borderRadius: '22px',
            padding: '28px',
            border: '1px solid rgba(20, 184, 166, 0.35)',
            color: '#0f172a',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <strong style={{ fontSize: '0.95rem', letterSpacing: '0.4px' }}>Pro tip</strong>
          <p style={{ margin: 0, lineHeight: 1.65 }}>{track.tip}</p>
          <div
            style={{
              background: 'rgba(15, 23, 42, 0.08)',
              borderRadius: '16px',
              padding: '18px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <span style={{ fontWeight: 600 }}>Validation checklist</span>
            <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <li>File size up to 8 MB</li>
              <li>Show supported formats inline</li>
              <li>Preview captured contact details</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
