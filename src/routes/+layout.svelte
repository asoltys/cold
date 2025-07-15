<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

	<div
		class="container mx-auto max-w-3xl space-y-5 rounded-2xl bg-gray-100 p-8 text-xl shadow-lg"
	>
		<div class="flex items-center justify-center gap-2">
			<img src="/bitcoin.svg" />
			<div>
				<a href="/" class="mx-auto text-2xl">Bitcoin Wallet</a>
			</div>
		</div>

		{@render children()}
	</div>
