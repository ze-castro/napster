<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';

	/** An error in plain words, with the tool's own output one click away. */
	let { message, detail, compact = false }: { message: string; detail?: string; compact?: boolean } = $props();

	let copied = $state(false);
	async function copy() {
		if (!detail) return;
		await navigator.clipboard.writeText(detail).catch(() => undefined);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class={['flex flex-col gap-1.5', !compact && 'rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2']}>
	<p class={['text-destructive', compact ? 'text-xs' : 'text-sm']}>{message}</p>
	{#if detail}
		<details class="group text-xs">
			<summary class="w-fit cursor-pointer text-muted-foreground select-none hover:text-foreground">
				<span class="group-open:hidden">Show details</span>
				<span class="hidden group-open:inline">Hide details</span>
			</summary>
			<div class="relative mt-1.5">
				<pre class="max-h-56 overflow-auto rounded-md bg-muted px-3 py-2 pr-9 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">{detail}</pre>
				<button
					type="button"
					class="absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
					onclick={copy}
					aria-label="Copy details"
				>
					{#if copied}<Check class="size-3.5" />{:else}<Copy class="size-3.5" />{/if}
				</button>
			</div>
		</details>
	{/if}
</div>
