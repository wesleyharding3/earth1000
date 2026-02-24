/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 *
 */
if (typeof require !== 'undefined')
	var chai = require("chai"),
		promise = require("../index");

var expect = chai.expect;

describe("immediates new Promise", function() {
	describe("immediate promise with success", function() {
		var res = null;
		new promise.Promise()
			.resolve("foo")
			.done(function(success) {
				res = success;
			});
		it("should", function() {
			expect(res).equals("foo");
		});
	});
	describe("immediate promise with error", function() {
		var res = null;
		new promise.Promise()
			.reject(new Error("blam!"))
			.fail(function(error) {
				res = error.message;
			});
		it("should", function() {
			expect(res).equals("blam!");
		});
	});
	describe("immediate promise with always success ", function() {
		var res = null;
		new promise.Promise()
			.resolve("reu")
			.always(function(success) {
				res = success;
			});
		it("should", function() {
			expect(res).equals("reu");
		});
	});

	describe("immediate promise with always error ", function() {
		var res = null;
		new promise.Promise()
			.reject(new Error("blam!"))
			.always(function(s, error) {
				res = error.message;
			});
		it("should", function() {
			expect(res).equals("blam!");
		});
	});


	describe("immediate promise with then success ", function() {
		var res = null;
		new promise.Promise()
			.resolve("reu")
			.then(function(success) {
				res = success;
			});
		it("should", function() {
			expect(res).equals("reu");
		});
	});

	describe("immediate promise with then error ", function() {
		var res = null;
		new promise.Promise()
			.reject(new Error("reu"))
			.then(function(success) {
				res = "fromDone-" + success;
			}, function(error) {
				res = "fromFail-" + error.message;
			});
		it("should", function() {
			expect(res).equals("fromFail-reu");
		});
	});

	describe("immediate promise with success and fail ommition", function() {
		var res = null;
		new promise.Promise()
			.resolve("foo")
			.done(function(success) {
				res = success;
				return res;
			})
			.fail(function(error) {
				res = error.message;
			});
		it("should", function() {
			expect(res).equals("foo");
		});
	});
	describe("immediate promise with error and done ommition", function() {
		var res = null;
		new promise.Promise()
			.reject(new Error("blam!"))
			.fail(function(error) {
				res = error.message;
				return error;
			})
			.done(function(success) {
				res = "fromDone";
			});
		it("should", function() {
			expect(res).equals("blam!");
		});
	});
	describe("immediate promise with error and recuperation", function() {
		var res = null;
		new promise.Promise()
			.reject(new Error("blam!"))
			.fail(function(error) {
				return true;
			})
			.done(function(success) {
				res = "fromDone";
			});
		it("should", function() {
			expect(res).equals("fromDone");
		});
	});
	describe("immediate promise with error and return undefined", function() {
		var res = null;
		new promise.Promise()
			.reject(new Error("blam!"))
			.fail(function(error) {
				res = error.message;
			})
			.done(function(success) {
				res += "-fromDone";
			})
			.fail(function(error) {
				res += "-fromFail";
			});
		it("should", function() {
			expect(res).equals("blam!-fromFail");
		});
	});
	describe("immediate promise with success and return value", function() {
		var res = null;
		new promise.Promise()
			.resolve("foo")
			.done(function(success) {
				return "zoo-" + success;
			})
			.done(function(success) {
				res = "bar-" + success;
			});
		it("should", function() {
			expect(res).equals("bar-zoo-foo");
		});
	});
	describe("immediate promise with success and return undefined", function() {
		var res = null;
		new promise.Promise()
			.resolve("foo")
			.done(function(success) {
				res = "zoo-";
			})
			.done(function(success) {
				res += "bar-" + success;
			});
		it("should", function() {
			expect(res).equals("zoo-bar-foo");
		});
	});
	describe("immediate promise with always twice", function() {
		var res = null;
		new promise.Promise()
			.resolve("foo-")
			.done(function(success) {
				res = "zoo-" + success;
			})
			.always(function(s, e) {
				res += "always-";
				return new Error("bar")
			})
			.always(function(s, e) {
				res += "bloupi-" + e.message;
			})
		it("should", function() {
			expect(res).equals("zoo-foo-always-bloupi-bar");
		});
	});
	describe("immediate promise with then twice", function() {
		var res = null;
		new promise.Promise()
			.resolve("foo")
			.done(function(success) {
				res = "zoo-";
			})
			.then(function(s) {
				res += "then-";
			})
			.then(function(s) {
				res += "bloupi-" + s;
			})
		it("should", function() {
			expect(res).equals("zoo-then-bloupi-foo");
		});
	});
});



describe("delayed new Promise", function() {
	describe("delayed done", function() {

		var res = null;

		before(function(done) {
			new promise.Promise().delay(2).resolve("boo")
				.done(function(success) {
					res += success;
					done();
				});
			res = "far-";
		});

		it("should", function() {
			expect(res).equals("far-boo");
		});
	});
	describe("delayed fail", function() {

		var res = "";

		before(function(done) {
			new promise.Promise().delay(2) // WARNING : delay is DONE
				.reject(new Error("floup"))
				.fail(function(error) {
					res += error.message;
					done();
				});
			res += "far-";
		});

		it("should", function() {
			expect(res).equals("far-floup");
		});
	});

	describe("delayed done with arg forwarding", function() {

		var res = "";

		before(function(done) {
			new promise.Promise() // WARNING : delay is DONE
				.resolve("bloupi")
				.done(function(success) {
					res += "first-";
				})
				.delay(2)
				.done(function(success) {
					res += success;
					done();
				});
			res += "far-";
		});

		it("should", function() {
			expect(res).equals("first-far-bloupi");
		});
	});
});

describe("when", function() {

	describe("when done", function() {
		var res = null;
		promise.when("foo")
			.done(function(s) {
				res = s;
			});

		it("should", function() {
			expect(res).equals("foo");
		});
	});
	describe("when fail", function() {
		var res = null;
		promise.when(new Error("bar"))
			.fail(function(e) {
				res = e.message;
			});

		it("should", function() {
			expect(res).equals("bar");
		});
	});
	describe("when success return delayed promise", function() {
		var res = null;
		before(function(done) {
			promise.when(" world ")
				.delay(1)
				.done(function(arg) {
					return promise.when(1).delay(1)
						.then(function(arg2) {
							return "hello" + arg + arg2;
						});
				})
				.done(function(success) {
					res = success;
					done();
				});
		});

		it("should", function() {
			expect(res).equals("hello world 1");
		});
	});

	describe("when success return value injection", function() {

		var res = null,
			res2 = null;
		before(function(done) {
			promise.when({
					test: 1
				})
				.done(function(s) {
					s.e = 2;
					res = s;
				})
				.done(function(s) {
					return "changed value";
				})
				.done(function(success) {
					res2 = success;
					done();
				});
		});

		it("should", function() {
			expect(JSON.stringify(res))
				.equals(JSON.stringify({
					test: 1,
					e: 2
				}));
			expect(res2).equals("changed value");
		});
	});

	describe("when success return error", function() {

		var res = null;
		before(function(done) {
			promise.when({})
				.done(function() {
					return new Error("the injected error");
				})
				.done(function(s) {
					return "should not see this";
				})
				.fail(function(e) {
					return e.message;
				})
				.done(function(success) {
					res = success;
					done();
				})
		});

		it("should", function() {
			expect(res).equals("the injected error");
		});
	});
	describe("when success throw error and catch", function() {

		var res = null;
		before(function(done) {
			promise.when({})
				.done(function() {
					throw new Error("the thrown error");
				})
				.done(function(s) {
					return "should not see this";
				})
				.fail(function(e) {
					return e.message;
				})
				.done(function(success) {
					res = success;
					done();
				});
		});

		it("should", function() {
			expect(res).equals("the thrown error");
		});

	});
});
describe("inner handle", function() {
	describe("inner-add done handle", function() {
		var res = null;
		before(function(done) {
			promise.when({})
				.done(function(s) {
					this.done(function(s) {
						return "passed through";
					});
					return "should not see this";
				})
				.done(function(success) {
					res = success;
					done();
				});
		});
		it("should", function() {
			expect(res).equals("passed through");
		});
	});
});


describe("contextualisation", function() {

});


describe("logs", function() {

	var Logger = function(){
		this.stdout = [];
		this.stderr = [];
	};
	Logger.prototype  = {
		log:function(){
			this.stdout = this.stdout.concat(Array.prototype.slice.call(arguments).map(function(s){ return String(s); }));
		},
		error:function () {
			this.stderr = this.stderr.concat(Array.prototype.slice.call(arguments).map(function(s){ return String(s); }));
		},
		debug:function () {
			this.stdout = this.stdout.concat(Array.prototype.slice.call(arguments).map(function(s){ return String(s); }));
		}
	};

	describe("log success", function() {
		var logger = promise.Promise.logger = new Logger();

		promise.when("bloupi").log();

		it("should", function() {
			expect(logger.stdout[0]).equals("bloupi");
		});
	});

	describe("log error", function() {
		var logger = promise.Promise.logger = new Logger();

		promise.when(new Error("bar")).log();

		it("should", function() {
			expect(logger.stderr[0]).equals("Error: bar");
		});
	});
	describe("slog", function() {
		var logger = promise.Promise.logger = new Logger();

		promise.when("bloupi").slog();

		it("should", function() {
			expect(logger.stdout[0]).equals("bloupi");
		});
	});
	describe("elog", function() {
		var logger = promise.Promise.logger = new Logger();

		promise.when(new Error("bar")).elog();

		it("should", function() {
			expect(logger.stderr[0]).equals("Error: bar");
		});
	});
	describe("debug with debug=true in context", function() {

		promise.Promise.context = {
			debug: true
		};

		var logger = promise.Promise.logger = new Logger();

		promise.when("bloupi").debug();

		it("should", function() {
			expect(logger.stdout[0]).equals("bloupi");
		});
	});
	describe("debug with debug=false in context", function() {

		promise.Promise.context = {
			debug: false
		};

		var logger = promise.Promise.logger = new Logger();

		promise.when("bloupi").debug();

		it("should", function() {
			expect(logger.stdout.length).equals(0);
		});
	});
	describe("context log", function() {

		promise.Promise.context = {
			bloupi: "goldberg"
		};

		var logger = promise.Promise.logger = new Logger();

		promise.when(null).clog("bloupi");

		it("should", function() {
			expect(logger.stdout[1]).equals("goldberg");
		});
	});
});

describe("deferred", function() {

});
describe("state", function() {

});
describe("custom API", function() {

});
describe("promisify", function() {
	// spread
});