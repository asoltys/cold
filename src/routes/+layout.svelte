<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<div class="container mx-auto mt-10 space-y-5 rounded-2xl bg-gray-100 p-8 text-xl shadow-lg">
	<div class="flex">
		<a href="/" class="mx-auto text-2xl">Bitcoin Wallet</a>
	</div>

	{@render children()}
</div>

<div class="my-4 flex">
	<a href="https://github.com/asoltys/paper" class="mx-auto">Source code</a>
</div>
