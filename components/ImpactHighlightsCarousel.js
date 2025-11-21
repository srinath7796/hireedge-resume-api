import { useMemo, useState } from 'react';
import styles from '../styles/Home.module.css';

const highlights = [
  {
    title: 'Revenue Platform Launch',
    metric: 'Lifted net expansion +14%',
    description:
      'Quantified the retention impact of lifecycle nudges and brought sales + success into a weekly “north-star” forum.',
    guidance: 'Feature this above the fold in the résumé impact section.',
  },
  {
    title: 'Experimentation Engine',
    metric: 'Accelerated ship cadence 26%',
    description:
      'Paired discovery research with dual-track rituals, cutting launch risk and surfacing two new monetisation bets.',
    guidance: 'Turn this into a case study card on the site.',
  },
  {
    title: 'Analytics Modernisation',
    metric: 'Reduced reporting lag 70%',
    description:
      'Implemented semantic layers and auto QA, letting execs self-serve insights during board prep.',
    guidance: 'Overlay this as a marquee testimonial quote.',
  },
];

export function ImpactHighlightsCarousel() {
  const [index, setIndex] = useState(0);
  const activeHighlight = useMemo(() => highlights[index], [index]);

  const shift = (delta) => {
    setIndex((prev) => (prev + delta + highlights.length) % highlights.length);
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Impact Highlight Spotlight</h2>
          <p>
            Celebrate quantified wins pulled straight from each résumé. Transform the
            carousel into social proof or a live ticker so prospects appreciate how the
            engine surfaces measurable outcomes.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            type="button"
            aria-label="Previous highlight"
            onClick={() => shift(-1)}
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '50%',
              border: 'none',
              cursor: 'pointer',
              background: 'rgba(15, 23, 42, 0.1)',
              color: '#0f172a',
              fontSize: '1.25rem',
              fontWeight: 600,
            }}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next highlight"
            onClick={() => shift(1)}
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '50%',
              border: 'none',
              cursor: 'pointer',
              background: 'rgba(15, 23, 42, 0.1)',
              color: '#0f172a',
              fontSize: '1.25rem',
              fontWeight: 600,
            }}
          >
            ›
          </button>
        </div>
      </div>

      <div
        style={{
          background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.12), rgba(239, 68, 68, 0.12))',
          borderRadius: '26px',
          padding: '32px',
          display: 'grid',
          gridTemplateColumns: 'minmax(240px, 0.9fr) 1fr',
          gap: '32px',
          alignItems: 'center',
        }}
      >
        <div>
          <span style={{ textTransform: 'uppercase', letterSpacing: '1.4px', color: '#334155' }}>
            Highlight {index + 1} / {highlights.length}
          </span>
          <h3 style={{ margin: '12px 0 10px', fontSize: '1.8rem', color: '#0f172a' }}>
            {activeHighlight.title}
          </h3>
          <p style={{ margin: 0, fontWeight: 600, color: '#0f172a' }}>{activeHighlight.metric}</p>
        </div>
        <div
          style={{
            background: '#0f172a',
            color: '#f8fafc',
            borderRadius: '22px',
            padding: '26px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            boxShadow: '0 30px 70px rgba(15, 23, 42, 0.32)',
          }}
        >
          <p style={{ margin: 0, fontSize: '1.05rem', lineHeight: 1.7 }}>
            {activeHighlight.description}
          </p>
          <div
            style={{
              padding: '14px 18px',
              background: 'rgba(148, 163, 184, 0.2)',
              borderRadius: '16px',
              fontSize: '0.95rem',
            }}
          >
            <strong style={{ display: 'block', marginBottom: '6px', letterSpacing: '0.4px' }}>
              Web placement prompt
            </strong>
            {activeHighlight.guidance}
          </div>
        </div>
      </div>
    </section>
  );
}
