export function SSBadge(props: { date: string }) {
	return (
		<div className="flex flex-row items-center mt-3 -ml-4 text-black font-roboto dark:text-white">
			<div className="text-3xl mr-2">📅</div>

			<div className="flex flex-col">
				<div className="font-semibold text-sm">Subscribed Since</div>
				<div className="opacity-80 text-sm">{props.date}</div>
			</div>
		</div>
	);
}
