<script lang="ts">
  import { useAppLevels, Screen, BackspaceIcon } from '@gphone/sdk';

  let { onback } = $props();

  let display = $state('0');

  // Calculator's one "level" is an entered number rather than a screen: back deletes a
  // digit until there is nothing left to delete, and only then leaves.
  const app = useAppLevels({
    title: 'Calculator',
    onback: () => onback?.(),
    levels: [{ open: () => display !== '0', close: () => handleBackspace() }]
  });
  let firstOperand: number | null = $state(null);
  let operator: string | null = $state(null);
  let waitingForSecondOperand = $state(false);

  const inputDigit = (digit: string) => {
    if (waitingForSecondOperand) {
      display = digit;
      waitingForSecondOperand = false;
    } else {
      display = display === '0' ? digit : display + digit;
    }
  };

  const inputDot = () => {
    if (waitingForSecondOperand) {
      display = '0.';
      waitingForSecondOperand = false;
      return;
    }
    if (!display.includes('.')) {
      display += '.';
    }
  };

  const clear = () => {
    display = '0';
    firstOperand = null;
    operator = null;
    waitingForSecondOperand = false;
  };

  const toggleSign = () => {
    display = String(parseFloat(display) * -1);
  };

  const inputPercent = () => {
    display = String(parseFloat(display) / 100);
  };

  const handleOperator = (nextOperator: string) => {
    const inputValue = parseFloat(display);

    if (operator && waitingForSecondOperand) {
      operator = nextOperator;
      return;
    }

    if (firstOperand === null) {
      firstOperand = inputValue;
    } else if (operator) {
      const result = calculate(firstOperand, inputValue, operator);
      display = String(result);
      if (typeof result === 'number') {
        firstOperand = result;
      } else {
        firstOperand = null;
        operator = null;
        return;
      }
    }

    waitingForSecondOperand = true;
    operator = nextOperator;
  };

  const calculate = (first: number, second: number, op: string): number | string => {
    let result: number;
    if (op === '+') result = first + second;
    else if (op === '-') result = first - second;
    else if (op === '×') result = first * second;
    else if (op === '÷') {
      if (second === 0) return 'Error';
      result = first / second;
    } else {
      result = second;
    }

    if (isNaN(result) || !isFinite(result)) return 'Error';
    // Avoid precision floating point issues like 0.1 + 0.2 = 0.30000000000000004
    return Math.round(result * 1e10) / 1e10;
  };

  const handleBackspace = () => {
    if (display === 'Error') {
      clear();
      return;
    }
    if (!waitingForSecondOperand && display.length > 1) {
      const next = display.slice(0, -1);
      display = next === '-' || next === '' ? '0' : next;
    } else {
      display = '0';
    }
  };

  const handleInput = (value: string) => {
    if (/[0-9]/.test(value)) {
      inputDigit(value);
    } else if (value === '.') {
      inputDot();
    } else if (value === 'C') {
      clear();
    } else if (value === '±') {
      toggleSign();
    } else if (value === '%') {
      inputPercent();
    } else if (value === '⌫' || value === 'Backspace') {
      handleBackspace();
    } else if (['+', '-', '×', '÷'].includes(value)) {
      handleOperator(value);
    } else if (value === '=') {
      if (operator && firstOperand !== null) {
        const result = calculate(firstOperand, parseFloat(display), operator);
        display = String(result);
        firstOperand = null;
        operator = null;
        waitingForSecondOperand = false;
      }
    }
  };

  const handleKeydown = (event: KeyboardEvent) => {
    // The shell dispatcher runs first and calls preventDefault on any key it consumed.
    // Escape used to fire twice — clearing the display here *and* navigating home — and
    // Backspace would double up the same way whenever a call was in progress.
    if (event.defaultPrevented) return;

    const { key } = event;

    if (/[0-9]/.test(key)) {
      inputDigit(key);
    } else if (key === '.') {
      inputDot();
    } else if (key === 'Enter' || key === '=') {
      event.preventDefault();
      if (operator && firstOperand !== null) {
        const result = calculate(firstOperand, parseFloat(display), operator);
        display = String(result);
        firstOperand = null;
        operator = null;
        waitingForSecondOperand = false;
      }
    } else if (key === '+' || key === '-') {
      handleOperator(key);
    } else if (key === '*' || key === 'x') {
      handleOperator('×');
    } else if (key === '/') {
      handleOperator('÷');
    }
  };
</script>

<svelte:window on:keydown={handleKeydown} />

<Screen title={app.title} onback={app.back}>
  <div class="flex h-full flex-col p-4">
    <!-- Display -->
    <div class="mb-8 flex flex-1 items-end justify-end text-6xl font-light break-all">
      {display}
    </div>

    <!-- Keypad -->
    <div class="grid grid-cols-4 gap-3">
      {#each ['C', '±', '%', '÷', '7', '8', '9', '×', '4', '5', '6', '-', '1', '2', '3', '+', '0', '.', '⌫', '='] as btn}
        <button
          class="flex aspect-square items-center justify-center rounded-full text-2xl font-medium transition-all active:scale-95
          {btn === '='
            ? 'bg-orange-500 hover:bg-orange-400'
            : ['C', '±', '%', '÷', '×', '-', '+'].includes(btn)
              ? 'bg-gray-600 hover:bg-gray-500'
              : 'bg-gray-800 hover:bg-gray-700'}"
          onclick={() => handleInput(btn)}
        >
          {#if btn === '⌫'}
            <BackspaceIcon class="h-6 w-6 text-white" />
          {:else}
            {btn}
          {/if}
        </button>
      {/each}
    </div>
  </div>
</Screen>
