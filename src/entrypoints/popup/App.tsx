import { useState } from "react";

function App() {
	const [count, setCount] = useState(0);

	return (
		<>
			<h1 className="text-3xl text-red-500 mb-5">Subscribed Since</h1>
			<div className="text-lg">
				<button
					className="border-2 border-red-600 rounded-xl p-3"
					onClick={() => setCount((count) => count + 1)}>
					count is {count}
				</button>
			</div>
		</>
	);
}

export default App;
