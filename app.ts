type Difficulty = "easy" | "medium" | "hard" | "expert" | "master";

interface HistoryState {
  grid: number[][];
  notes: string;
  hintsUsed: number;
}

interface SelectedCell {
  row: number;
  col: number;
}

interface GameState {
  grid: number[][];
  initialGrid: number[][];
  solution: number[][];
  notes: string;
  history: HistoryState[];
  difficulty: Difficulty;
  hintsUsed: number;
  elapsedTime: number;
}

class SudokuGame {
  private static readonly STORAGE_KEY = "sudokuGameState";

  private readonly appContainer: HTMLElement;
  private readonly liveRegion: HTMLElement;

  private grid: number[][] = [];
  private initialGrid: number[][] = [];
  private solution: number[][] = [];
  private notes: Array<Array<Set<number>>> = [];
  private history: HistoryState[] = [];
  private difficulty: Difficulty = "medium";
  private selectedDifficulty: Difficulty = "medium";
  private hintsUsed = 0;
  private elapsedTime = 0;
  private timer: number | null = null;
  private isGameWon = false;
  private isLoading = true;
  private isNotesMode = false;
  private errorCells: Set<string> = new Set();
  private selectedCell: SelectedCell | null = null;
  private justPlaced: string | null = null;
  private numberCounts: Record<number, number> = {};

  private puzzleWorker: Worker | null = null;

  private modalConfirmAction: (() => void) | null = null;
  private elementToFocusOnModalClose: HTMLElement | null = null;

  constructor(containerId: string) {
    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error(`Container with id "${containerId}" not found.`);
    }
    this.appContainer = container;
    this.liveRegion = this.createLiveRegion();
    this.init();
  }

  private createLiveRegion = (): HTMLElement => {
    const region = document.createElement("div");
    region.className = "sr-only";
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    document.body.appendChild(region);
    return region;
  };

  private announceMessage = (message: string): void => {
    this.liveRegion.textContent = message;
    setTimeout(() => {
      if (this.liveRegion.textContent === message) {
        this.liveRegion.textContent = "";
      }
    }, 1000);
  };

  private init = (): void => {
    this.setupDarkMode();
    this.initializeWorker();
    this.renderLayout();
    window.addEventListener("beforeunload", this.saveState);

    const wasLoaded = this.loadState();
    if (wasLoaded) {
      this.isLoading = false;
      this.updateUI();
      this.startTimer();
      this.announceMessage("Game loaded successfully.");
    } else {
      if (localStorage.getItem(SudokuGame.STORAGE_KEY)) {
        this.showModal(
          "Load Error",
          "Your saved game data was corrupted. A new game will be started."
        );
        localStorage.removeItem(SudokuGame.STORAGE_KEY);
      }
      this.startNewGame(false);
    }
  };

  private startNewGame = (isNew = true): void => {
    this.isLoading = true;
    this.stopTimer();
    if (isNew) {
      this.difficulty = this.selectedDifficulty;
    }
    this.updateUI();
    this.puzzleWorker?.postMessage({
      cmd: "generate",
      difficulty: this.difficulty,
    });
  };

  private renderLayout = (): void => {
    const layout = `
      <div class="flex flex-col items-center min-h-full w-full p-2 sm:p-4">
          <header class="text-center my-4 sm:my-6">
              <h1 class="text-4xl md:text-5xl font-bold tracking-tight">Sudoku⸆⸉</h1>
          </header>
          <main class="w-full flex flex-col lg:flex-row items-center justify-center lg:items-start gap-6 xl:gap-12">
              <div id="grid-container-wrapper" class="flex flex-col items-center"></div>
              <div id="controls-container" class="flex flex-col gap-4 w-full max-w-sm mt-4 lg:mt-0 lg:max-w-xs"></div>
          </main>
          <footer class="mt-auto pt-8 text-center text-slate-500 dark:text-slate-400 text-sm">
              <p>${new Date().getFullYear()} jj (( dodo )) 🐝🐢🐘💻💾🍕🥦🛹🎲⚛️🌌🍀🍃</p>
          </footer>
          <div id="modal-container"></div>
      </div>
    `;
    this.appContainer.innerHTML = layout;
  };

  private updateUI = (): void => {
    this.updateNumberCounts();
    this.updateGridContainer();
    this.updateControlsContainer();
  };

  private updateGridContainer = (): void => {
    const container = document.getElementById("grid-container-wrapper");
    if (!container) return;

    if (this.isLoading) {
      container.innerHTML = `<div class="grid-container flex items-center justify-center bg-slate-200 dark:bg-slate-800"><svg class="animate-spin h-12 w-12 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg></div>`;
      return;
    }

    let gridHtml = `<div id="sudoku-grid" role="grid" class="grid-container border-2 border-slate-800 dark:border-slate-700 bg-slate-800 dark:bg-slate-700 shadow-2xl">`;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        gridHtml += this.renderCell(r, c);
      }
    }
    gridHtml += `</div>`;
    container.innerHTML = gridHtml;

    const gridEl = document.getElementById("sudoku-grid");
    gridEl?.addEventListener("click", this.handleCellClick);
    gridEl?.addEventListener("focusin", this.handleCellClick);
    gridEl?.addEventListener("keydown", this.handleGridKeyDown);
  };

  private updateControlsContainer = (): void => {
    const container = document.getElementById("controls-container");
    if (!container) return;

    container.innerHTML =
      this.renderStats() + this.renderNumpad() + this.renderControls();
    this.attachControlListeners();
  };

  private renderCell = (r: number, c: number): string => {
    const cellValue = this.grid[r][c];
    const isPrefilled = this.initialGrid[r][c] !== 0;
    const cellClasses = this.getCellClasses(r, c);
    const ariaLabel = `Cell R${r + 1} C${c + 1}, ${cellValue ? `Value ${cellValue}` : "Empty"
      }`;

    let cellContent = "";
    if (cellValue !== 0) {
      const popInClass =
        this.justPlaced === `${r}-${c}` ? "animate-pop-in" : "";
      cellContent = `<span class="${popInClass}">${cellValue}</span>`;
    } else if (this.notes[r]?.[c]?.size > 0) {
      let notesHtml =
        '<div class="notes-grid text-slate-500 dark:text-slate-400">';
      for (let n = 1; n <= 9; n++) {
        notesHtml += `<span>${this.notes[r][c].has(n) ? n : ""}</span>`;
      }
      notesHtml += "</div>";
      cellContent = notesHtml;
    }

    return `<div id="cell-${r}-${c}" class="${cellClasses.join(
      " "
    )}" role="gridcell" aria-label="${ariaLabel}" tabindex="${isPrefilled ? -1 : 0
      }" data-row="${r}" data-col="${c}">${cellContent}</div>`;
  };

  private updateAllCells = (): void => {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cellEl = document.getElementById(`cell-${r}-${c}`);
        if (cellEl) {
          cellEl.className = this.getCellClasses(r, c).join(" ");
          const cellValue = this.grid[r][c];
          let cellContent = "";

          if (cellValue !== 0) {
            const popInClass =
              this.justPlaced === `${r}-${c}` ? "animate-pop-in" : "";
            cellContent = `<span class="${popInClass}">${cellValue}</span>`;
          } else if (this.notes[r]?.[c]?.size > 0) {
            let notesHtml =
              '<div class="notes-grid text-slate-500 dark:text-slate-400">';
            for (let n = 1; n <= 9; n++) {
              notesHtml += `<span>${this.notes[r][c].has(n) ? n : ""}</span>`;
            }
            notesHtml += "</div>";
            cellContent = notesHtml;
          }
          cellEl.innerHTML = cellContent;
        }
      }
    }
  };

  private getCellClasses = (row: number, col: number): string[] => {
    const classes = [
      "cell",
      "flex",
      "items-center",
      "justify-center",
      "border-slate-300",
      "dark:border-slate-600",
      "border-b",
      "border-r",
    ];
    const { row: selR, col: selC } = this.selectedCell || { row: -1, col: -1 };
    const selectedValue =
      selR !== -1 && this.grid[selR]?.[selC] > 0 ? this.grid[selR][selC] : null;

    if (this.isGameWon) {
      classes.push(
        "game-won",
        "bg-green-100",
        "dark:bg-green-900",
        "text-green-800",
        "dark:text-green-200"
      );
    } else if (this.initialGrid[row][col] !== 0) {
      classes.push(
        "pre-filled",
        "bg-slate-100",
        "dark:bg-slate-850",
        "font-bold"
      );
    } else {
      classes.push(
        "user-input",
        "text-blue-600",
        "dark:text-blue-400",
        "cursor-pointer",
        "bg-white",
        "dark:bg-slate-900",
        "hover:bg-slate-50",
        "dark:hover:bg-slate-850"
      );
    }

    if (!this.isGameWon && selR !== -1) {
      if (row === selR && col === selC) {
        classes.push("selected", "bg-blue-200", "dark:bg-slate-700");
      } else if (
        row === selR ||
        col === selC ||
        (Math.floor(row / 3) === Math.floor(selR / 3) &&
          Math.floor(col / 3) === Math.floor(selC / 3))
      ) {
        classes.push("peer", "bg-slate-100", "dark:bg-slate-850");
      }
      if (selectedValue && this.grid[row][col] === selectedValue) {
        classes.push("same-value", "bg-blue-100", "dark:bg-slate-600");
      }
    }

    if (this.errorCells.has(`${row}-${col}`)) {
      classes.push(
        "error",
        "animate-shake",
        "bg-red-200",
        "dark:bg-red-900",
        "text-red-700",
        "dark:text-red-300"
      );
    }
    if (col % 3 === 2 && col !== 8) {
      classes.push(
        "border-r-thick",
        "border-r-slate-800",
        "dark:border-r-slate-700"
      );
    }
    if (row % 3 === 2 && row !== 8) {
      classes.push(
        "border-b-thick",
        "border-b-slate-800",
        "dark:border-b-slate-700"
      );
    }
    return classes;
  };

  private renderStats = (): string => {
    return `
      <div class="grid grid-cols-2 gap-4 text-center">
          <div class="bg-white dark:bg-slate-800 p-4 rounded-lg shadow-md border border-slate-200 dark:border-slate-700">
              <p id="difficulty-label" class="text-sm font-medium text-slate-600 dark:text-slate-400">Difficulty</p>
              <p class="text-xl font-semibold capitalize" aria-labelledby="difficulty-label">${this.difficulty
      }</p>
          </div>
          <div class="bg-white dark:bg-slate-800 p-4 rounded-lg shadow-md border border-slate-200 dark:border-slate-700">
              <p id="timer-label" class="text-sm font-medium text-slate-600 dark:text-slate-400">Time</p>
              <p id="timer" class="text-xl font-semibold tracking-wider" aria-labelledby="timer-label">${this.getFormattedTime()}</p>
          </div>
      </div>`;
  };

  private renderNumpad = (): string => {
    let numpadHtml = `<div role="toolbar" aria-label="Number input controls" class="grid grid-cols-5 gap-2">`;
    for (let i = 1; i <= 9; i++) {
      const isDisabled = this.numberCounts[i] === 9;
      numpadHtml += `<button data-num="${i}" ${isDisabled ? "disabled" : ""
        } aria-label="Input ${i}" class="numpad-btn w-full h-14 text-2xl font-semibold bg-white dark:bg-slate-800 rounded-lg shadow-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all">${i}</button>`;
    }
    numpadHtml += `<button data-num="0" aria-label="Erase number" class="numpad-btn w-full h-14 text-2xl font-semibold bg-white dark:bg-slate-800 rounded-lg shadow-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button></div>`;
    return numpadHtml;
  };

  private renderControls = (): string => {
    const notesToggleClasses = this.isNotesMode
      ? "bg-blue-600"
      : "bg-slate-200 dark:bg-slate-700";
    const notesSpanClasses = this.isNotesMode
      ? "translate-x-6"
      : "translate-x-1";
    return `
      <div class="bg-white dark:bg-slate-800 p-4 rounded-lg shadow-md border border-slate-200 dark:border-slate-700 space-y-3">
          <h2 class="text-lg font-semibold text-center">Controls</h2>
          <div class="flex items-center">
              <label for="difficulty-select" class="text-slate-700 dark:text-slate-300 mr-3 flex-shrink-0">New Game:</label>
              <select id="difficulty-select" class="w-full bg-slate-50 dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2.5">
                  <option value="easy" ${this.selectedDifficulty === "easy" ? "selected" : ""
      }>Easy</option>
                  <option value="medium" ${this.selectedDifficulty === "medium" ? "selected" : ""
      }>Medium</option>
                  <option value="hard" ${this.selectedDifficulty === "hard" ? "selected" : ""
      }>Hard</option>
                  <option value="expert" ${this.selectedDifficulty === "expert" ? "selected" : ""
      }>Expert</option>
                  <option value="master" ${this.selectedDifficulty === "master" ? "selected" : ""
      }>Master</option>
              </select>
              <button id="start-new-game-btn" class="ml-3 px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg shadow-sm hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 transition">Start</button>
          </div>
          <div class="flex items-center justify-between">
              <label for="notes-toggle" class="text-slate-700 dark:text-slate-300">Notes Mode (N)</label>
              <button id="notes-toggle" role="switch" aria-checked="${this.isNotesMode
      }" class="relative inline-flex items-center h-6 rounded-full w-11 ${notesToggleClasses} transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500">
                  <span class="inline-block w-4 h-4 transform bg-white rounded-full ${notesSpanClasses} transition-transform"/>
              </button>
          </div>
          <div class="grid grid-cols-3 gap-3">
              <button id="undo-btn" ${this.history.length === 0 || this.isGameWon ? "disabled" : ""
      } class="w-full bg-slate-500 text-white font-semibold py-3 rounded-lg shadow-sm hover:bg-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 transition disabled:bg-slate-400 disabled:cursor-not-allowed">Undo</button>
              <button id="validate-btn" class="w-full bg-green-600 text-white font-semibold py-3 rounded-lg shadow-sm hover:bg-green-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 transition">Validate</button>
              <button id="hint-btn" ${this.isGameWon || this.hintsUsed >= 3 ? "disabled" : ""
      } class="w-full bg-yellow-500 text-white font-semibold py-3 rounded-lg shadow-sm hover:bg-yellow-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 transition disabled:bg-slate-400 disabled:cursor-not-allowed">Hint (${3 - this.hintsUsed
      })</button>
          </div>
          <button id="solve-btn" class="w-full bg-slate-800 hover:bg-slate-900 dark:bg-slate-850 dark:hover:bg-black text-white font-semibold py-3 rounded-lg shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-700 transition">Solve Puzzle</button>
      </div>`;
  };

  private attachControlListeners = (): void => {
    document
      .getElementById("start-new-game-btn")
      ?.addEventListener("click", this.startNewGameConfirm);
    document
      .getElementById("difficulty-select")
      ?.addEventListener("change", (e) => {
        this.selectedDifficulty = (e.target as HTMLSelectElement)
          .value as Difficulty;
      });
    document
      .getElementById("notes-toggle")
      ?.addEventListener("click", this.toggleNotesMode);
    document.getElementById("undo-btn")?.addEventListener("click", this.undo);
    document
      .getElementById("validate-btn")
      ?.addEventListener("click", this.checkSolution);
    document
      .getElementById("hint-btn")
      ?.addEventListener("click", this.getHint);
    document
      .getElementById("solve-btn")
      ?.addEventListener("click", this.solvePuzzleConfirm);
    this.appContainer.querySelectorAll(".numpad-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const num = parseInt((btn as HTMLElement).dataset.num!);
        this.inputNumber(num);
      });
    });
  };

  private handleCellClick = (e: Event): void => {
    const target = (e.target as HTMLElement).closest(
      ".cell"
    ) as HTMLElement | null;
    if (target?.dataset.row && target.dataset.col) {
      const row = parseInt(target.dataset.row);
      const col = parseInt(target.dataset.col);
      if (this.initialGrid[row]?.[col] === 0) {
        this.selectCell(row, col);
      }
    }
  };

  private selectCell = (row: number, col: number): void => {
    if (this.isGameWon) return;
    this.selectedCell = { row, col };
    this.updateAllCells();
    document.getElementById(`cell-${row}-${col}`)?.focus();
  };

  private inputNumber = (num: number): void => {
    if (
      !this.selectedCell ||
      this.isGameWon ||
      this.initialGrid[this.selectedCell.row][this.selectedCell.col] !== 0
    ) {
      return;
    }
    const { row, col } = this.selectedCell;
    this.pushToHistory();

    if (this.isNotesMode) {
      if (this.grid[row][col] !== 0) this.grid[row][col] = 0;
      if (num === 0) {
        this.notes[row][col].clear();
      } else {
        this.notes[row][col].has(num)
          ? this.notes[row][col].delete(num)
          : this.notes[row][col].add(num);
      }
    } else {
      this.notes[row][col].clear();
      this.grid[row][col] = num === 0 ? 0 : num;
      this.justPlaced = `${row}-${col}`;
      setTimeout(() => {
        this.justPlaced = null;
        this.updateAllCells();
      }, 300);
      this.checkForWin();
    }
    this.updateUI();
  };

  private handleGridKeyDown = (e: KeyboardEvent): void => {
    if (!this.selectedCell || this.isGameWon) return;
    const { row, col } = this.selectedCell;

    const keyMap: { [key: string]: [number, number] } = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };

    if (keyMap[e.key]) {
      e.preventDefault();
      const [dr, dc] = keyMap[e.key];
      let newRow = (row + dr + 9) % 9;
      let newCol = (col + dc + 9) % 9;
      while (this.initialGrid[newRow][newCol] !== 0) {
        newRow = (newRow + dr + 9) % 9;
        newCol = (newCol + dc + 9) % 9;
        if (newRow === row && newCol === col) break;
      }
      this.selectCell(newRow, newCol);
    } else if (e.key >= "1" && e.key <= "9") {
      this.inputNumber(parseInt(e.key));
    } else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") {
      this.inputNumber(0);
    } else if (e.key.toLowerCase() === "n") {
      this.toggleNotesMode();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      this.undo();
    }
  };

  private toggleNotesMode = (): void => {
    this.isNotesMode = !this.isNotesMode;
    this.announceMessage(`Notes mode ${this.isNotesMode ? "on" : "off"}.`);
    this.updateControlsContainer();
  };

  private undo = (): void => {
    if (this.history.length === 0 || this.isGameWon) return;
    const lastState = this.history.pop()!;
    this.grid = lastState.grid;
    const parsedNotes = JSON.parse(lastState.notes) as number[][][];
    this.notes = parsedNotes.map((row) => row.map((cell) => new Set(cell)));
    this.hintsUsed = lastState.hintsUsed;
    this.updateUI();
    this.announceMessage("Last move undone.");
  };

  private checkSolution = (): void => {
    this.errorCells.clear();
    let isFull = true;
    let hasErrors = false;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const val = this.grid[r][c];
        if (val === 0) {
          isFull = false;
          continue;
        }
        if (val !== this.solution[r][c]) {
          this.errorCells.add(`${r}-${c}`);
          hasErrors = true;
        }
      }
    }

    if (hasErrors) {
      this.showModal("Errors Found", "Incorrect cells have been highlighted.");
    } else if (!isFull) {
      this.showModal(
        "Grid Incomplete",
        "The grid is valid so far, but not all cells are filled."
      );
    } else {
      this.checkForWin();
    }

    this.updateAllCells();
    setTimeout(() => {
      this.errorCells.clear();
      this.updateAllCells();
    }, 2000);
  };

  private getHint = (): void => {
    if (this.isGameWon || this.hintsUsed >= 3) return;
    const emptyCells: SelectedCell[] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (this.grid[r][c] === 0) emptyCells.push({ row: r, col: c });
      }
    }

    if (emptyCells.length > 0) {
      this.pushToHistory();
      const { row, col } =
        emptyCells[Math.floor(Math.random() * emptyCells.length)];
      this.grid[row][col] = this.solution[row][col];
      this.notes[row][col].clear();
      this.hintsUsed++;
      this.announceMessage(
        `Hint used. Cell R${row + 1} C${col + 1} is ${this.grid[row][col]}.`
      );
      this.updateUI();
      this.checkForWin();
    }
  };

  private solvePuzzle = (): void => {
    this.pushToHistory();
    this.grid = JSON.parse(JSON.stringify(this.solution));
    this.notes.forEach((row) => row.forEach((cellNotes) => cellNotes.clear()));
    this.isGameWon = true;
    this.stopTimer();
    this.updateUI();
    this.announceMessage("Puzzle solved.");
  };

  private startNewGameConfirm = (): void => {
    if (this.history.length === 0 || this.isGameWon) {
      this.startNewGame();
    } else {
      this.showModal(
        "Start New Game?",
        "Abandon your current progress?",
        this.startNewGame
      );
    }
  };

  private solvePuzzleConfirm = (): void => {
    this.showModal("Solve Puzzle?", "Reveal the solution?", this.solvePuzzle);
  };

  private showModal = (
    title: string,
    message: string,
    onConfirm: (() => void) | null = null
  ): void => {
    this.elementToFocusOnModalClose = document.activeElement as HTMLElement;
    this.modalConfirmAction = onConfirm;
    const modalContainer = document.getElementById("modal-container");
    if (!modalContainer) return;

    modalContainer.innerHTML = `
      <div id="modal-backdrop" class="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div id="modal-content" role="dialog" aria-modal="true" aria-labelledby="modal-title" class="bg-white dark:bg-slate-800 rounded-lg shadow-xl p-6 m-4 max-w-sm text-center">
              <h3 id="modal-title" class="text-2xl font-bold mb-4">${title}</h3>
              <p class="text-slate-700 dark:text-slate-300 mb-6">${message}</p>
              <div class="flex justify-center gap-4">
                  ${onConfirm
        ? '<button id="modal-confirm-btn" class="px-6 py-2 bg-blue-600 text-white font-semibold rounded-lg shadow-md hover:bg-blue-700">Confirm</button>'
        : ""
      }
                  <button id="modal-cancel-btn" class="px-6 py-2 bg-slate-200 dark:bg-slate-600 text-slate-800 dark:text-slate-200 font-semibold rounded-lg shadow-md hover:bg-slate-300 dark:hover:bg-slate-500">${onConfirm ? "Cancel" : "Close"
      }</button>
              </div>
          </div>
      </div>`;

    document
      .getElementById("modal-cancel-btn")
      ?.addEventListener("click", this.hideModal);
    document
      .getElementById("modal-confirm-btn")
      ?.addEventListener("click", () => {
        this.modalConfirmAction?.();
        this.hideModal();
      });
    document
      .getElementById("modal-backdrop")
      ?.addEventListener("click", (e) => {
        if (e.target === e.currentTarget) this.hideModal();
      });
  };

  private hideModal = (): void => {
    const modalContainer = document.getElementById("modal-container");
    if (modalContainer) modalContainer.innerHTML = "";
    this.modalConfirmAction = null;
    this.elementToFocusOnModalClose?.focus();
    this.elementToFocusOnModalClose = null;
  };

  private checkForWin = (): void => {
    const isSolved = this.grid.every((row, r) =>
      row.every((cell, c) => cell === this.solution[r][c] && cell !== 0)
    );

    if (isSolved) {
      this.isGameWon = true;
      this.stopTimer();
      this.selectedCell = null;
      this.updateAllCells();
      const message = `You solved the ${this.difficulty
        } puzzle in ${this.getFormattedTime()}!`;
      this.showModal("Congratulations!", message);
      this.announceMessage(`Puzzle solved. ${message}`);
      localStorage.removeItem(SudokuGame.STORAGE_KEY);
    }
  };

  private getFormattedTime = (): string => {
    const minutes = Math.floor(this.elapsedTime / 60);
    const seconds = this.elapsedTime % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
      2,
      "0"
    )}`;
  };

  private updateNumberCounts = (): void => {
    this.numberCounts = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
      6: 0,
      7: 0,
      8: 0,
      9: 0,
    };
    this.grid.flat().forEach((cell) => {
      if (cell > 0) this.numberCounts[cell]++;
    });
  };

  private setupDarkMode = (): void => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = (e: MediaQueryListEvent | MediaQueryList) => {
      document.documentElement.classList.toggle("dark", e.matches);
    };
    query.addEventListener("change", updateTheme);
    updateTheme(query);
  };

  private initializeWorker = (): void => {
    const workerScript = `
      const shuffle = (array) => { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } return array; };
      const isValid = (board, row, col, num) => {
          for (let i = 0; i < 9; i++) { if (board[row][i] === num || board[i][col] === num) return false; }
          const startRow = Math.floor(row / 3) * 3, startCol = Math.floor(col / 3) * 3;
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (board[startRow + i][startCol + j] === num) return false;
          return true;
      };
      const solve = (board) => {
          for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (board[r][c] === 0) {
              const nums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
              for (const num of nums) if (isValid(board, r, c, num)) { board[r][c] = num; if (solve(board)) return true; board[r][c] = 0; }
              return false;
          }
          return true;
      };
      const hasUniqueSolution = (board) => {
          let solutionCount = 0;
          const find = (b) => {
              let r = -1, c = -1;
              for (let i = 0; i < 81; i++) if (b[Math.floor(i/9)][i%9] === 0) { r = Math.floor(i/9); c = i%9; break; }
              if (r === -1) { solutionCount++; return; }
              for (let num = 1; num <= 9 && solutionCount <= 1; num++) if (isValid(b, r, c, num)) { b[r][c] = num; find(b); }
              b[r][c] = 0;
          };
          const boardCopy = JSON.parse(JSON.stringify(board));
          find(boardCopy);
          return solutionCount === 1;
      };
      const generatePuzzle = (diff) => {
          const grid = Array(9).fill().map(() => Array(9).fill(0));
          solve(grid);
          const solution = JSON.parse(JSON.stringify(grid));
          const difficultyMap = { easy: 38, medium: 46, hard: 53, expert: 59, master: 64 };
          let cellsToRemove = difficultyMap[diff] || 46;
          const cells = shuffle(Array.from({ length: 81 }, (_, i) => ({ r: Math.floor(i / 9), c: i % 9 })));
          while (cells.length > 0 && cellsToRemove > 0) {
              const { r, c } = cells.pop();
              const temp = grid[r][c];
              grid[r][c] = 0;
              if (!hasUniqueSolution(grid)) grid[r][c] = temp;
              else cellsToRemove--;
          }
          return { puzzle: grid, solution };
      };
      self.onmessage = (e) => {
          if (e.data.cmd === 'generate') {
              const { puzzle, solution } = generatePuzzle(e.data.difficulty);
              self.postMessage({ puzzle, solution });
          }
      };
    `;
    const blob = new Blob([workerScript], { type: "application/javascript" });
    this.puzzleWorker = new Worker(URL.createObjectURL(blob));
    this.puzzleWorker.onmessage = this.handleWorkerMessage;
  };

  private handleWorkerMessage = (
    event: MessageEvent<{ puzzle: number[][]; solution: number[][] }>
  ): void => {
    const { puzzle, solution } = event.data;
    this.grid = puzzle;
    this.initialGrid = JSON.parse(JSON.stringify(puzzle));
    this.solution = solution;
    this.notes = Array(9)
      .fill(null)
      .map(() =>
        Array(9)
          .fill(null)
          .map(() => new Set())
      );
    this.history = [];
    this.hintsUsed = 0;
    this.elapsedTime = 0;
    this.isGameWon = false;
    this.isLoading = false;
    this.selectedCell = null;
    this.updateUI();
    this.startTimer();
    this.announceMessage(`New ${this.difficulty} game started.`);
  };

  private startTimer = (): void => {
    this.stopTimer();
    this.timer = window.setInterval(() => {
      if (!this.isGameWon) {
        this.elapsedTime++;
        const timerEl = document.getElementById("timer");
        if (timerEl) timerEl.textContent = this.getFormattedTime();
      }
    }, 1000);
  };

  private stopTimer = (): void => {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  };

  private pushToHistory = (): void => {
    this.history.push({
      grid: JSON.parse(JSON.stringify(this.grid)),
      notes: JSON.stringify(this.notes, (k, v) =>
        v instanceof Set ? [...v] : v
      ),
      hintsUsed: this.hintsUsed,
    });
  };

  private saveState = (): void => {
    if (this.isGameWon || this.isLoading) return;
    const state: GameState = {
      grid: this.grid,
      initialGrid: this.initialGrid,
      solution: this.solution,
      notes: JSON.stringify(this.notes, (k, v) =>
        v instanceof Set ? [...v] : v
      ),
      history: this.history,
      difficulty: this.difficulty,
      hintsUsed: this.hintsUsed,
      elapsedTime: this.elapsedTime,
    };
    try {
      localStorage.setItem(SudokuGame.STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("Failed to save game state:", e);
    }
  };

  private loadState = (): boolean => {
    try {
      const savedState = localStorage.getItem(SudokuGame.STORAGE_KEY);
      if (savedState) {
        const state = JSON.parse(savedState) as GameState;
        if (!state.grid || !state.initialGrid || !state.solution) {
          throw new Error("Invalid game state");
        }
        this.grid = state.grid;
        this.initialGrid = state.initialGrid;
        this.solution = state.solution;
        const parsedNotes = JSON.parse(state.notes) as number[][][];
        this.notes = parsedNotes.map((row) => row.map((cell) => new Set(cell)));
        this.history = state.history || [];
        this.difficulty = state.difficulty;
        this.selectedDifficulty = state.difficulty;
        this.hintsUsed = state.hintsUsed;
        this.elapsedTime = state.elapsedTime;
        this.isGameWon = false;
        return true;
      }
    } catch (e) {
      console.error("Failed to load game state:", e);
      localStorage.removeItem(SudokuGame.STORAGE_KEY);
    }
    return false;
  };
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => new SudokuGame("app-container")
  );
} else {
  new SudokuGame("app-container");
}
