import { CRTRenderer } from './renderer';
import { AudioManager } from './audio';
import { KnobController, type KnobParam } from './knobs';
import {
  findBestSignalMatch,
  getSignalColor,
  WeatherSystem,
  lerp,
  type SignalMatch
} from './signal';
import type { Signal, SignalsData, TunerState, WeatherOffset } from './types';

class Game {
  private renderer: CRTRenderer | null = null;
  private audioManager: AudioManager;
  private knobController: KnobController | null = null;
  private weatherSystem: WeatherSystem | null = null;

  private signals: Signal[] = [];
  private tuner: TunerState = { vhf: 100, uhf: 400, antenna: 180 };
  private weatherOffset: WeatherOffset = { vhfShift: 0, uhfShift: 0, antennaShift: 0 };
  private currentMatch: SignalMatch = { signal: null, strength: 0, vhfMatch: 0, uhfMatch: 0, antennaMatch: 0 };

  private smoothedStrength: number = 0;
  private smoothedDistortion: number = 1;
  private smoothedStatic: number = 1;
  private smoothedVhsTint: number = 0;
  private smoothedSignalColor: [number, number, number] = [0.08, 0.08, 0.1];

  private foundSignals: Set<string> = new Set();
  private signalOverlayActive: boolean = false;
  private binaryStream: string = '';
  private binaryTimer: number = 0;

  private signalNotes: Map<string, string> = new Map();
  private readonly NOTES_STORAGE_KEY = 'channel_zero_signal_notes';
  private readonly FOUND_STORAGE_KEY = 'channel_zero_found_signals';

  private draftNotes: Map<string, string> = new Map();
  private activeNoteSignalId: string | null = null;
  private activeNoteElement: HTMLTextAreaElement | null = null;

  private elements: {
    signalFill: HTMLElement;
    signalOverlay: HTMLElement;
    signalName: HTMLElement;
    signalDescription: HTMLElement;
    binaryStream: HTMLElement;
    foundCount: HTMLElement;
    audioToggle: HTMLButtonElement;
    archiveList: HTMLElement;
  };

  constructor() {
    this.audioManager = new AudioManager();
    this.elements = this.getElements();
  }

  private getElements() {
    const get = (id: string): HTMLElement => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`Element not found: ${id}`);
      return el;
    };

    return {
      signalFill: get('signalFill'),
      signalOverlay: get('signalOverlay'),
      signalName: get('signalOverlay').querySelector('.signal-name') as HTMLElement,
      signalDescription: get('signalOverlay').querySelector('.signal-description') as HTMLElement,
      binaryStream: get('signalOverlay').querySelector('.binary-stream') as HTMLElement,
      foundCount: get('foundCount'),
      audioToggle: get('audioToggle') as HTMLButtonElement,
      archiveList: get('archiveList')
    };
  }

  async init(): Promise<void> {
    try {
      const signalsData = await this.loadSignals();
      this.signals = signalsData.signals;
      this.weatherSystem = new WeatherSystem(signalsData.weatherConfig);
    } catch (e) {
      console.error('Failed to load signals:', e);
      return;
    }

    this.loadFromStorage();

    const canvas = document.getElementById('glCanvas') as HTMLCanvasElement;
    this.renderer = new CRTRenderer(canvas);

    this.knobController = new KnobController([
      {
        param: 'vhf',
        element: document.getElementById('vhfKnob')!,
        valueElement: document.getElementById('vhfValue')!,
        min: 0,
        max: 250,
        initialValue: 100,
        sensitivity: 0.8
      },
      {
        param: 'uhf',
        element: document.getElementById('uhfKnob')!,
        valueElement: document.getElementById('uhfValue')!,
        min: 100,
        max: 800,
        initialValue: 400,
        sensitivity: 1.2
      },
      {
        param: 'antenna',
        element: document.getElementById('antennaKnob')!,
        valueElement: document.getElementById('antennaValue')!,
        min: 0,
        max: 360,
        initialValue: 180,
        sensitivity: 1.5
      }
    ], (param: KnobParam, value: number) => {
      this.tuner[param] = value;
    });

    this.elements.audioToggle.addEventListener('click', async () => {
      if (!this.audioManager['isInitialized']) {
        await this.audioManager.init();
      }
      this.audioManager.resume();
      const enabled = this.audioManager.toggle();
      this.elements.audioToggle.classList.toggle('active', enabled);
    });

    window.addEventListener('resize', () => {
      this.renderer?.resize();
    });

    window.addEventListener('beforeunload', () => {
      this.saveAllPendingNotes();
    });

    window.addEventListener('blur', () => {
      this.saveAllPendingNotes();
    });

    void this.knobController;

    this.renderArchive();
    this.animate();
  }

  private loadFromStorage(): void {
    try {
      const foundRaw = localStorage.getItem(this.FOUND_STORAGE_KEY);
      if (foundRaw) {
        const foundArray = JSON.parse(foundRaw) as string[];
        this.foundSignals = new Set(foundArray);
        this.elements.foundCount.textContent = `Signals found: ${this.foundSignals.size} / ${this.signals.length}`;
      }
    } catch (e) {
      console.warn('Failed to load found signals from storage:', e);
    }

    try {
      const notesRaw = localStorage.getItem(this.NOTES_STORAGE_KEY);
      if (notesRaw) {
        const notesObj = JSON.parse(notesRaw) as Record<string, string>;
        this.signalNotes = new Map(Object.entries(notesObj));
        this.draftNotes = new Map(Object.entries(notesObj));
      }
    } catch (e) {
      console.warn('Failed to load notes from storage:', e);
    }
  }

  private saveFoundSignals(): void {
    try {
      localStorage.setItem(this.FOUND_STORAGE_KEY, JSON.stringify(Array.from(this.foundSignals)));
    } catch (e) {
      console.warn('Failed to save found signals:', e);
    }
  }

  private saveNoteToStorage(): boolean {
    try {
      const notesObj: Record<string, string> = {};
      this.draftNotes.forEach((value, key) => {
        notesObj[key] = value;
      });
      localStorage.setItem(this.NOTES_STORAGE_KEY, JSON.stringify(notesObj));
      this.signalNotes = new Map(this.draftNotes);
      return true;
    } catch (e) {
      console.warn('Failed to save notes to storage:', e);
      return false;
    }
  }

  private setNoteStatus(signalId: string, status: 'saving' | 'saved' | 'error' | ''): void {
    const statusEl = document.querySelector(`[data-note-status="${signalId}"]`) as HTMLElement | null;
    if (!statusEl) return;
    statusEl.classList.remove('saving', 'saved', 'error');
    if (status) {
      statusEl.classList.add(status);
      if (status === 'saving') statusEl.textContent = 'SAVING...';
      else if (status === 'saved') statusEl.textContent = 'SAVED';
      else if (status === 'error') statusEl.textContent = '! SAVE FAILED - DRAFT KEPT';
    } else {
      statusEl.textContent = '';
    }
  }

  private commitDraft(signalId: string): boolean {
    const draftValue = this.draftNotes.get(signalId);
    if (draftValue === undefined) return true;

    const saved = this.saveNoteToStorage();
    if (saved) {
      this.setNoteStatus(signalId, 'saved');
      window.setTimeout(() => {
        this.setNoteStatus(signalId, '');
      }, 1500);
    } else {
      this.setNoteStatus(signalId, 'error');
    }
    return saved;
  }

  private handleNoteInput(signalId: string, value: string): void {
    this.draftNotes.set(signalId, value);
    this.setNoteStatus(signalId, 'saving');

    const saved = this.saveNoteToStorage();
    if (saved) {
      this.setNoteStatus(signalId, 'saved');
      window.setTimeout(() => {
        this.setNoteStatus(signalId, '');
      }, 1000);
    } else {
      this.setNoteStatus(signalId, 'error');
    }
  }

  private handleNoteBlur(signalId: string): void {
    const draftValue = this.draftNotes.get(signalId);
    const storedValue = this.signalNotes.get(signalId);

    if (draftValue !== undefined && draftValue !== storedValue) {
      this.commitDraft(signalId);
    }

    if (this.activeNoteSignalId === signalId) {
      this.activeNoteSignalId = null;
      this.activeNoteElement = null;
    }
  }

  private handleNoteFocus(signalId: string, element: HTMLTextAreaElement): void {
    this.activeNoteSignalId = signalId;
    this.activeNoteElement = element;
  }

  private saveAllPendingNotes(): void {
    this.draftNotes.forEach((_value, signalId) => {
      const draftValue = this.draftNotes.get(signalId);
      const storedValue = this.signalNotes.get(signalId);
      if (draftValue !== undefined && draftValue !== storedValue) {
        this.commitDraft(signalId);
      }
    });
  }

  private preserveActiveNoteState(): { signalId: string; value: string; selectionStart: number; selectionEnd: number } | null {
    if (!this.activeNoteSignalId || !this.activeNoteElement) return null;
    try {
      return {
        signalId: this.activeNoteSignalId,
        value: this.activeNoteElement.value,
        selectionStart: this.activeNoteElement.selectionStart,
        selectionEnd: this.activeNoteElement.selectionEnd
      };
    } catch {
      return null;
    }
  }

  private restoreActiveNoteState(state: { signalId: string; value: string; selectionStart: number; selectionEnd: number } | null): void {
    if (!state) return;
    const textarea = document.querySelector<HTMLTextAreaElement>(`[data-note-input="${state.signalId}"]`);
    if (textarea) {
      textarea.value = state.value;
      this.activeNoteElement = textarea;
      this.activeNoteSignalId = state.signalId;
      try {
        textarea.focus();
        textarea.setSelectionRange(state.selectionStart, state.selectionEnd);
      } catch {
        // Ignore selection restore errors
      }
    }
  }

  private renderArchive(): void {
    const container = this.elements.archiveList;
    const activeState = this.preserveActiveNoteState();

    if (this.foundSignals.size === 0) {
      container.innerHTML = `
        <div class="archive-empty">
          NO SIGNALS ARCHIVED<br />
          <span style="color: #2a2418;">Tune in to discover transmissions...</span>
        </div>
      `;
      return;
    }

    const foundSignalList = this.signals.filter(s => this.foundSignals.has(s.id));

    container.innerHTML = foundSignalList.map(signal => {
      const note = this.draftNotes.get(signal.id) || this.signalNotes.get(signal.id) || '';
      return `
        <div class="archive-item" data-signal-id="${signal.id}">
          <div class="archive-item-header">
            <span class="archive-signal-name">${signal.name}</span>
            <span class="archive-signal-id">${signal.id.toUpperCase()}</span>
          </div>
          <div class="archive-signal-desc">${signal.description}</div>
          <div class="note-paper">
            <div class="note-label">Personal Note</div>
            <textarea
              class="note-textarea"
              data-note-input="${signal.id}"
              placeholder="Write your observations about this signal..."
              spellcheck="false"
            >${this.escapeHtml(note)}</textarea>
            <div class="note-status" data-note-status="${signal.id}"></div>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll<HTMLTextAreaElement>('[data-note-input]').forEach(textarea => {
      const signalId = textarea.dataset.noteInput;
      if (!signalId) return;

      textarea.addEventListener('input', (e) => {
        const target = e.target as HTMLTextAreaElement;
        this.handleNoteInput(signalId, target.value);
      });

      textarea.addEventListener('focus', () => {
        this.handleNoteFocus(signalId, textarea);
      });

      textarea.addEventListener('blur', () => {
        this.handleNoteBlur(signalId);
      });

      textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          this.commitDraft(signalId);
        }
      });
    });

    this.restoreActiveNoteState(activeState);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private async loadSignals(): Promise<SignalsData> {
    const response = await fetch('/signals.json');
    if (!response.ok) throw new Error('Failed to load signals');
    return response.json();
  }

  private updateSignalMatch(): void {
    this.currentMatch = findBestSignalMatch(this.tuner, this.signals, this.weatherOffset);
  }

  private updateSmoothing(): void {
    const targetStrength = this.currentMatch.strength;
    this.smoothedStrength = lerp(this.smoothedStrength, targetStrength, 0.12);

    const targetDistortion = 1 - this.smoothedStrength * 0.85;
    this.smoothedDistortion = lerp(this.smoothedDistortion, targetDistortion, 0.1);

    const targetStatic = 1 - this.smoothedStrength * 0.7;
    this.smoothedStatic = lerp(this.smoothedStatic, targetStatic, 0.15);

    const targetVhsTint = this.smoothedStrength > 0.4 ? this.smoothedStrength : 0;
    this.smoothedVhsTint = lerp(this.smoothedVhsTint, targetVhsTint, 0.08);

    const targetColor = getSignalColor(this.currentMatch.signal, this.smoothedStrength);
    this.smoothedSignalColor = [
      lerp(this.smoothedSignalColor[0], targetColor[0], 0.1),
      lerp(this.smoothedSignalColor[1], targetColor[1], 0.1),
      lerp(this.smoothedSignalColor[2], targetColor[2], 0.1)
    ];
  }

  private updateUI(): void {
    const fillPercent = Math.min(100, this.smoothedStrength * 100);
    this.elements.signalFill.style.width = `${fillPercent.toFixed(1)}%`;

    const shouldShowOverlay = this.smoothedStrength > 0.7;
    if (shouldShowOverlay !== this.signalOverlayActive) {
      this.signalOverlayActive = shouldShowOverlay;
      this.elements.signalOverlay.classList.toggle('active', shouldShowOverlay);

      if (shouldShowOverlay && this.currentMatch.signal) {
        const signal = this.currentMatch.signal;
        this.elements.signalName.textContent = signal.name;
        this.elements.signalDescription.textContent = signal.description;
        this.binaryStream = signal.fragmentPath;

        if (!this.foundSignals.has(signal.id)) {
          this.saveAllPendingNotes();
          this.foundSignals.add(signal.id);
          this.elements.foundCount.textContent = `Signals found: ${this.foundSignals.size} / ${this.signals.length}`;
          this.saveFoundSignals();
          this.renderArchive();
        }
      }
    }

    this.binaryTimer += 1;
    if (this.binaryTimer > 3 && this.signalOverlayActive) {
      this.binaryTimer = 0;
      const len = this.binaryStream.length;
      const extra = Math.floor(Math.random() * 12) + 4;
      let display = this.binaryStream;
      for (let i = 0; i < extra; i++) {
        display += Math.random() > 0.5 ? '1' : '0';
      }
      this.elements.binaryStream.textContent = display.substring(0, Math.min(len + extra, 80));
    }
  }

  private animate(): void {
    if (this.weatherSystem) {
      const weatherResult = this.weatherSystem.update();
      this.weatherOffset = weatherResult.offset;
      this.updateSignalMatch();
      this.updateSmoothing();

      if (this.renderer) {
        this.renderer.render({
          signalStrength: this.smoothedStrength,
          staticAmount: this.smoothedStatic,
          distortionAmount: this.smoothedDistortion,
          vhsTint: this.smoothedVhsTint,
          signalColor: this.smoothedSignalColor,
          rainIntensity: weatherResult.rainIntensity,
          flash: weatherResult.flash
        });
      }

      this.audioManager.setNoiseIntensity(this.smoothedStrength);
      if (this.currentMatch.signal && this.smoothedStrength > 0.3) {
        const baseFreq = this.currentMatch.signal.id === 'signal_01' ? 220
          : this.currentMatch.signal.id === 'signal_02' ? 440
          : this.currentMatch.signal.id === 'signal_03' ? 660
          : 330;
        const wobble = Math.sin(performance.now() * 0.008) * 15;
        this.audioManager.setSignalTone(baseFreq + wobble, this.smoothedStrength);
      } else {
        this.audioManager.setSignalTone(0, 0);
      }
      this.audioManager.update();

      this.updateUI();
    }

    requestAnimationFrame(() => this.animate());
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const game = new Game();
  await game.init();
});
