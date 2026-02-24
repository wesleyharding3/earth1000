/**  @author Gilles Coomans <gilles.coomans@gmail.com> */
require.config({
	baseUrl: "/statics/libs",
	deps: ["./test.js"],
	paths: {
		"deep-utils": "/statics/libs/deep-utils"
	},
	callback: mocha.run
});