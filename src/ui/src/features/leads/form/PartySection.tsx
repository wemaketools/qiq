import { useEffect, useRef, useState } from 'react';
import Icon from '../../../components/common/Icon';
import { listParties, type PartyDto } from '../../parties/partiesApi';
import PartyFields from '../../parties/PartyFields';
import type { PartyFieldName, PartyFieldValues } from '../../parties/partyFieldValues';

interface ReferenceOption {
  id: number;
  name: string;
}

const SEARCH_DEBOUNCE_MS = 250;

function optionName(options: ReferenceOption[] | null, id: number | null): string {
  if (id == null) {
    return '—';
  }
  return options?.find((option) => option.id === id)?.name ?? '—';
}

interface PartySectionProps {
  /** True when the form was opened with `?partyId=` (spec FR-27, AC-026): the section is locked to
   * this party and renders `[data-testid='party-section-locked']` — this also completes T-025's
   * cross-task V-026 assertion ("+ New Lead opens intake pre-filled and locked to this party"). */
  locked: boolean;
  lockedParty: PartyDto | null;
  selectedParty: PartyDto | null;
  partyMode: 'existing' | 'new';
  inlineParty: PartyFieldValues;
  inlinePartyErrors: Partial<Record<PartyFieldName, string>>;
  inlinePartyTouched: Partial<Record<PartyFieldName, boolean>>;
  partyPickerError?: string;
  partyTypeOptions: ReferenceOption[] | null;
  segmentOptions: ReferenceOption[] | null;
  industryOptions: ReferenceOption[] | null;
  regionOptions: ReferenceOption[] | null;
  onSelectParty: (party: PartyDto) => void;
  onStartNewParty: () => void;
  onCancelNewParty: () => void;
  onChangeParty: () => void;
  onInlinePartyChange: <K extends keyof PartyFieldValues>(field: K, value: PartyFieldValues[K]) => void;
  onInlinePartyBlur: (field: PartyFieldName) => void;
}

/**
 * Party section of the lead intake/edit form (spec FR-29, PRD 9.3, AC-028): a type-ahead over
 * `partiesApi.listParties`; selecting a party collapses to a read-only summary card
 * (type/segment/industry/region). "+ New party" expands the same field components the standalone
 * Party form uses (`../../parties/PartyFields`, T-025) rather than duplicating them. When `locked`
 * is true (the form was opened with `?partyId=`), the section shows only the locked party's summary.
 */
function PartySection({
  locked,
  lockedParty,
  selectedParty,
  partyMode,
  inlineParty,
  inlinePartyErrors,
  inlinePartyTouched,
  partyPickerError,
  partyTypeOptions,
  segmentOptions,
  industryOptions,
  regionOptions,
  onSelectParty,
  onStartNewParty,
  onCancelNewParty,
  onChangeParty,
  onInlinePartyChange,
  onInlinePartyBlur,
}: PartySectionProps) {
  const [searchText, setSearchText] = useState('');
  const [results, setResults] = useState<PartyDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [noMatches, setNoMatches] = useState(false);
  const [open, setOpen] = useState(false);

  const searchBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (locked || selectedParty || partyMode === 'new' || searchText.trim().length === 0) {
      setResults([]);
      setNoMatches(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setNoMatches(false);
    const handle = window.setTimeout(() => {
      listParties({ search: searchText, page: 1, pageSize: 10 })
        .then((result) => {
          if (!cancelled) {
            setResults(result.items);
            setNoMatches(result.items.length === 0);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearching(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [searchText, locked, selectedParty, partyMode]);

  const showPanel = open && searchText.trim().length > 0 && (searching || results.length > 0 || noMatches);

  // Click-away closes the overlay (same pattern as GlobalSearch).
  useEffect(() => {
    if (!showPanel) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [showPanel]);

  function renderSummaryCard(party: PartyDto, testId: string) {
    return (
      <dl data-testid={testId} className="qiq-dl">
        <div>
          <dt>Party</dt>
          <dd>{party.name}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{optionName(partyTypeOptions, party.partyTypeId)}</dd>
        </div>
        <div>
          <dt>Segment</dt>
          <dd>{optionName(segmentOptions, party.segmentId)}</dd>
        </div>
        <div>
          <dt>Industry</dt>
          <dd>{optionName(industryOptions, party.industryId)}</dd>
        </div>
        <div>
          <dt>Region</dt>
          <dd>{optionName(regionOptions, party.regionId)}</dd>
        </div>
      </dl>
    );
  }

  if (locked) {
    return (
      <section data-testid="party-section-locked">
        <h3 className="qiq-form-section-title" style={{ marginBottom: 'var(--qiq-space-4)' }}>
          Party
        </h3>
        {lockedParty ? renderSummaryCard(lockedParty, 'party-summary-collapsed') : <p>Loading party…</p>}
      </section>
    );
  }

  return (
    <section data-testid="party-section">
      <h3 className="qiq-form-section-title" style={{ marginBottom: 'var(--qiq-space-4)' }}>
        Party
      </h3>

      {selectedParty && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)' }}>
          {renderSummaryCard(selectedParty, 'party-summary-collapsed')}
          <button type="button" data-testid="change-party-button" onClick={onChangeParty} style={{ alignSelf: 'flex-start' }}>
            Change party
          </button>
        </div>
      )}

      {!selectedParty && partyMode === 'existing' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-3)', alignItems: 'flex-start' }}>
          <div className="qiq-field" style={{ alignSelf: 'stretch', maxWidth: '480px' }}>
            <label htmlFor="lead-party-search">Party</label>
            <div className="qiq-searchselect-control" ref={searchBoxRef}>
              <input
                id="lead-party-search"
                data-testid="party-select"
                type="text"
                role="combobox"
                aria-expanded={showPanel}
                aria-controls="lead-party-search-results"
                aria-autocomplete="list"
                placeholder="Search parties by name"
                value={searchText}
                onChange={(event) => {
                  setSearchText(event.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setOpen(false);
                  }
                }}
              />
              <Icon name="search" size={16} />
              {showPanel && (
                <div className="qiq-searchselect-results" id="lead-party-search-results">
                  {searching && <p className="qiq-searchselect-hint">Searching…</p>}
                  {!searching && noMatches && <p className="qiq-searchselect-hint">No matches</p>}
                  {results.length > 0 && (
                    <ul data-testid="party-search-results" role="listbox">
                      {results.map((party) => (
                        <li key={party.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={false}
                            className="qiq-searchselect-option"
                            data-testid="party-search-result"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => onSelectParty(party)}
                          >
                            {party.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            {partyPickerError && (
              <p data-testid="field-error" role="alert" className="qiq-field-error">
                {partyPickerError}
              </p>
            )}
          </div>
          <button type="button" data-testid="new-party-button" onClick={onStartNewParty}>
            + New party
          </button>
        </div>
      )}

      {!selectedParty && partyMode === 'new' && (
        <div data-testid="new-party-fields" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--qiq-space-4)' }}>
          <PartyFields
            idPrefix="lead-new-party"
            values={inlineParty}
            errors={inlinePartyErrors}
            touched={inlinePartyTouched}
            partyTypeOptions={partyTypeOptions}
            segmentOptions={segmentOptions}
            industryOptions={industryOptions}
            regionOptions={regionOptions}
            onChange={onInlinePartyChange}
            onBlur={onInlinePartyBlur}
          />
          <button type="button" data-testid="cancel-new-party-button" onClick={onCancelNewParty} style={{ alignSelf: 'flex-start' }}>
            Cancel new party
          </button>
        </div>
      )}
    </section>
  );
}

export default PartySection;
