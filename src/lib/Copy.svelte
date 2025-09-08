<script>
	let { text = $bindable() } = $props();
	let justCopied = $state();
	const copy = () => {
		navigator.clipboard.writeText(text);
		justCopied = true;
		setTimeout(() => (justCopied = false), 1000);
	};
</script>

<div data-tip="Copied!" class:tooltip={justCopied}>
	<button type="button" class="btn" onclick={copy}>
		<iconify-icon icon="ph:copy-bold" width={32} />
	</button>
</div>
