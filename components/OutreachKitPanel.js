import { useState } from 'react';
import styles from '../styles/Home.module.css';

const kitContent = {
  elevatorPitch:
    'Hey Taylor — I help product pods ship outcomes faster by pairing discovery interviews with quantified growth experiments.',
  valueHook:
    'At NovaTech I led a retention squad that lifted expansion revenue 18% by prioritising research-backed lifecycle nudges.',
  emailSubject: 'Taylor, 3 sprints to unblock your roadmap',
  linkedinNote:
    'Loved your note about shipping velocity. Happy to share how we coached PMs + eng to cut cycle time 22% while retaining quality.',
};

export function OutreachKitPanel() {
  const [copiedField, setCopiedField] = useState(null);

  const handleCopy = async (label, value) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        setCopiedField(label);
        setTimeout(() => setCopiedField(null), 2000);
      }
    } catch (error) {
      console.error('Clipboard unsupported', error);
    }
  };

  const renderCard = (label, value, accent) => (
    <div
      key={label}
      style={{
        background: 'rgba(15, 23, 42, 0.92)',
        color: '#e2e8f0',
        padding: '24px',
        borderRadius: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        border: `1px solid ${accent}`,
        boxShadow: '0 25px 60px rgba(15, 23, 42, 0.35)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ letterSpacing: '0.6px', textTransform: 'uppercase', color: accent }}>
          {label}
        </strong>
        <button
          type="button"
          onClick={() => handleCopy(label, value)}
          style={{
            border: 'none',
            borderRadius: '12px',
            padding: '8px 14px',
            background: accent,
            color: '#0f172a',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {copiedField === label ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p style={{ margin: 0, lineHeight: 1.7, fontSize: '1.05rem' }}>{value}</p>
    </div>
  );

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Opportunity Outreach Kit</h2>
          <p>
            Give candidates ready-to-send messaging the moment their résumé finishes
            generating. Pair each snippet with social proof and one-click copy buttons
            to emphasise HireEdge’s unique outreach differentiator.
          </p>
        </div>
        <button className={styles.ctaButton} type="button">
          Launch Outreach Preview
        </button>
      </div>

      <div className={styles.row}>
        {renderCard('Elevator Pitch', kitContent.elevatorPitch, '#38bdf8')}
        {renderCard('Value Hook', kitContent.valueHook, '#f97316')}
        {renderCard('Email Subject', kitContent.emailSubject, '#a855f7')}
        {renderCard('LinkedIn Note', kitContent.linkedinNote, '#34d399')}
      </div>

      <div
        style={{
          background: 'rgba(148, 163, 184, 0.12)',
          borderRadius: '20px',
          padding: '20px 24px',
          color: '#1e293b',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <strong style={{ fontSize: '0.95rem' }}>Customer proof tip</strong>
        <span>
          “The outreach kit gave me the exact phrasing to DM a hiring manager — they
          replied within an hour.” — Amara, Product Ops Lead
        </span>
      </div>
    </section>
  );
}
