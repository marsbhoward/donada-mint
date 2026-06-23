import React, { useRef, useState } from 'react';

export default function DisclaimerModal({ onAccept, onDecline }) {
  const bodyRef = useRef(null);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) {
      setScrolledToBottom(true);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-sheet disclaimer-modal">
        <h2 className="disclaimer-title">Before You Continue</h2>

        <div className="disclaimer-body" ref={bodyRef} onScroll={handleScroll}>
          <section className="disclaimer-section">
            <h4>Sweepstakes Legality</h4>
            <p>
              The legality of sweepstakes varies by location. It is your sole responsibility
              to verify that participation is lawful in your jurisdiction before proceeding.
              DONADA does not constitute legal advice and makes no representations regarding
              the legality of participation in any specific region.
            </p>
          </section>

          <section className="disclaimer-section">
            <h4>Void Where Prohibited</h4>
            <p>
              This sweepstakes is void where prohibited by law. DONADA is intended to
              operate exclusively in regions where such promotions are legally permitted.
              By proceeding, you confirm that participation is lawful where you are located.
            </p>
          </section>

          <section className="disclaimer-section">
            <h4>Prize Distribution</h4>
            <p>
              DONADA will distribute <strong>20% of all ADA accumulated from NFT minting</strong> as
              sweepstakes prizes. Prizes will be distributed over <strong>4 quarterly drawings</strong>.
              Distribution is subject to applicable laws and regulations.
            </p>
          </section>

          <section className="disclaimer-section">
            <h4>Odds of Winning</h4>
            <p>
              The odds of winning are determined by the total number of entries divided by 2.
              An equal number of free entries will be made available, meaning paid and free
              entries are matched on a 1-to-1 basis.
            </p>
          </section>

          <section className="disclaimer-section">
            <h4>No Purchase Necessary</h4>
            <p>
              No purchase is necessary to enter or win. A purchase does not improve your
              odds of winning. Free entries are available on equal terms to all eligible
              participants. Void where prohibited.
            </p>
          </section>
        </div>

        <p className="disclaimer-confirm-text">
          {scrolledToBottom
            ? <>By clicking <strong>I Accept</strong>, you confirm you have read and understood the above, and that participation in this sweepstakes is legal in your jurisdiction.</>
            : 'Scroll to the bottom to continue.'}
        </p>

        <div className="disclaimer-actions">
          <button className="select-btn disclaimer-decline-btn" onClick={onDecline}>
            I Do Not Accept
          </button>
          <button
            className="select-btn disclaimer-accept-btn"
            onClick={onAccept}
            disabled={!scrolledToBottom}
            style={!scrolledToBottom ? { opacity: 0.35, cursor: 'not-allowed' } : undefined}
          >
            I Accept
          </button>
        </div>
      </div>
    </div>
  );
}
