chrome.webRequest.onBeforeRequest.addListener(function (details) {

	if (details.url.includes('https://mope.io/client.js') || details.url.includes('https://mope.io/client.js?additional=mope.js?additional=mope.js?additional=mope.js?additional=mope.js?additional=mope.js?additional=mope.js')) {
		var urlLocal = chrome.runtime.getURL("mope.js");
		console.log("Success!");
		chrome.pageAction.setIcon({
			path: 'icon_48.png',
			tabId: details.tabId
		});
		chrome.pageAction.show(details.tabId);
			return {
				redirectUrl: urlLocal
			};
	}

}, {
	urls: ["<all_urls>"]
}, ["blocking"]);