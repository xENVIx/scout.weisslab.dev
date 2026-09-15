let images = [];
let currentImage = 0;

fetch("/media/pictures/slideshow/")
	.then(response => response.text())
	.then(html => {
		const parser = new DOMParser();
		const document = parser.parseFromString(html, "text/html");

		images = Array.from(document.querySelectorAll("a"))
			.map(link => link.getAttribute("href"))
			.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));

		if (images.length > 0) {
			showImage();
		}
	});

function showImage() {
	document.getElementById("slideshow").src =
		"/media/pictures/slideshow/" + images[currentImage];
}

function nextImage() {
	currentImage++;

	if (currentImage >= images.length) {
		currentImage = 0;
	}

	showImage();
}

function previousImage() {
	currentImage--;

	if (currentImage < 0) {
		currentImage = images.length - 1;
	}

	showImage();
}