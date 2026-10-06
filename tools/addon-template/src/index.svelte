<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    Screen,
    EmptyState,
    ListItem,
    MessageBar,
    useAppAction,
    useAppEvents,
    useAppLevels,
    useService,
    onAppForeground,
    type AppProps
  } from '@mica/sdk';
  import { notes as notesService, NOTE_ADDED, type Note } from './service';

  /**
   * The annotation form, not `$props<AppProps>()` — the generic form only accepts an inline
   * object literal and reports "Expected 0 type arguments" for a named type.
   */
  let { onback }: AppProps = $props();

  let notes: Note[] = $state([]);
  let draft = $state('');
  let open: Note | null = $state(null);

  /**
   * Your server half, typed from its declaration in `service.ts`.
   *
   * `server.call('add', { text })` is checked against that file: a misspelt action or field,
   * or a number where `text` wants a string, fails `pnpm check`. The answer is typed too —
   * `Note` here, from `addonOutput<Note>()`. None of that is enforcement: micaOS parses every
   * payload against the same declaration on the server, whatever this side believed.
   */
  const server = useService(notesService);

  /** Busy flag and error toast around a write: a refusal from `add` is shown, not swallowed. */
  const { busy, run } = useAppAction('my_addon');

  /** One note in the list, once — the answer to `add` and its push can both bring it. */
  const keep = (note: Note) => {
    if (!notes.some((n) => n.id === note.id)) notes = [...notes, note];
  };

  /**
   * The back ladder, and the keyboard claim, in one call.
   *
   * Two things have to happen for back to work inside an app and either can be forgotten:
   * a ladder that closes the deepest open view instead of leaving, and claiming the `back`
   * action, because the shell owns Backspace and pre-empts anything wired only to
   * `<Screen onback>`. `useAppLevels` is both, which is why there is no way to describe the
   * levels and not claim the key.
   *
   * `appId` is required and must match the manifest's `id`. Apps are **resident** — this
   * ladder stays registered while your app sits in the background — so without an owner the
   * dispatcher would hand `back` to whichever app registered last rather than the one on
   * screen. `levels` are given deepest first and are read when back is pressed, not when
   * this is called, so `open` and `close` see current state.
   */
  const app = useAppLevels({
    appId: 'my_addon',
    title: 'My Add-on',
    onback: () => onback(),
    levels: [
      {
        open: () => open !== null,
        close: () => (open = null),
        title: () => 'Note'
      }
    ]
  });

  /**
   * `onAppForeground`, never `onMount` or a bare `$effect`.
   *
   * An installed app mounts once per session and stays mounted while the player uses other
   * apps, so anything fetched in `onMount` is fetched once and is stale the moment your app
   * goes to the background. The first argument is the app id, for the same residency reason
   * `useAppLevels` needs one.
   *
   * The third argument is the default a failed round trip resolves to — here, the list
   * already on screen — so a server half that is not running leaves the app usable. A
   * snapshot, because it crosses `postMessage` to the shell and a `$state` proxy cannot.
   */
  onAppForeground('my_addon', () => {
    void server.call('list', {}, $state.snapshot(notes)).then((list) => (notes = list));
  });

  /**
   * What the server half pushes with `exports.mica:PushToApp`. Needs `app-events` in the
   * manifest. A push is at most once and never queued, so it is a nudge: `list` on the next
   * foreground is what catches a phone up on anything it missed.
   */
  onDestroy(useAppEvents('my_addon').on<Note>(NOTE_ADDED, (event) => keep(event.payload)));

  const add = async () => {
    const text = draft.trim();
    if (text === '') return;
    if (await run(async () => keep(await server.call('add', { text })))) draft = '';
  };
</script>

<!--
  `Screen` owns the app viewport and hands its content box a definite height.

  Inside it, fill with `min-h-0 flex-1` — never `h-full`, never a bare `flex-1`. `h-full` is
  a percentage against a box that has already resolved; `flex-1` alone leaves
  `min-height: auto` intact, so the child is sized by its content and refuses to shrink.
  Both fail silently and only once there is enough content to overflow. A box that declares
  `overflow-y-auto` scrolls itself and is exempt.

  The screen is always 400x850. Do not write responsive CSS: breakpoints and viewport units
  (`vh`, `vw`, `dvh`) answer to the browser window, which is not the phone.
-->
<Screen title={app.title} onback={app.back}>
  {#if open !== null}
    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <p class="text-body-large text-on-surface">{open.text}</p>
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if notes.length === 0}
        <EmptyState
          title="No notes yet"
          description="Write one below. This add-on's own server resource keeps it."
        />
      {:else}
        {#each notes as note (note.id)}
          <ListItem onclick={() => (open = note)}>
            <p class="text-body-large text-on-surface">{note.text}</p>
          </ListItem>
        {/each}
      {/if}
    </div>
    <MessageBar bind:value={draft} placeholder="A note" maxlength={200} busy={$busy} onsend={add} />
  {/if}
</Screen>
