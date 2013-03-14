var  _  = require('underscore')
, anyDB = require('any-db')
, pool  = {}
, uri   = require('uri-js')
, River = require('da_river').River
;


// ****************************************************************
// ****************** Helpers *************************************
// ****************************************************************
//

var double_slashs = /\/\//g;
var mb            = function (num) { return num * 1024 * 1024; };
var now           = function () { return (new Date).getTime(); };

function doc_to_update_sql(set_doc, where_doc) {
  var vals  = [];
  var sql   = "UPDATE @table SET @set WHERE @where RETURNING * ;";
  var set   = [];
  var where = [];

  _.each(set_doc, function (v, k) {
    vals.push(v);
    set.push( k + " = $" + vals.length);
  });

  _.each(where_doc, function (v, k) {
    vals.push(v);
    where.push( k + " = $" + vals.length);
  });

  return {
    sql: sql.replace('@set', set.join(', ')).replace('@where', where.join(', ')),
    vals: vals
  };
}


function doc_to_set(doc, val_arr) {
  var arr = doc_to_equals(doc, val_arr);
  return arr.join(', ');
}

function doc_to_and(doc, val_arr) {
  var arr = doc_to_equals(doc, val_arr);
  return arr.join(' AND ');
}

function doc_to_equals(doc, val_arr) {
  var i = val_arr.length;
  var sql_vals = [];
  _.each(doc, function (v, k) {
    ++i;
    sql_vals.push( k + " = $" + i )
    val_arr.push(v);
  });

  return sql_vals;
}


// ****************************************************************
// ****************** Configs *************************************
// ****************************************************************


var T = exports.Topogo = function () {};
var Topogo = T;
T.close = function () {
  _.each(pool, function (v, key) {
    v.close();
  });
};

River.topogo = T;

T.id_size = 26;

T.sql = {
  select_default_owner : "\
    SELECT usename AS owner            \
    FROM pg_database, pg_user          \
    WHERE datname = current_database() \
      AND datdba = usesysid;           \
  ",

  select_databases : "\
    SELECT datname AS name            \
    FROM pg_database                  \
    WHERE datistemplate = false       \
        AND datname LIKE 'custom%';   \
  ",

  // FROM: http://stackoverflow.com/questions/769683/show-tables-in-postgresql
  select_tables : "SELECT table_schema || '.' || table_name AS name  \
    FROM    information_schema.tables                                \
    WHERE   table_type = 'BASE TABLE'                                \
    AND     table_schema NOT IN ('pg_catalog', 'information_schema') \
  "
};

// ****************************************************************
// ****************** Main Stuff **********************************
// ****************************************************************

T.new = function (name, db) {
  var t   = new T;
  t.table = name;
  t.name  = name;
  t.is_topogo = true;

  if (!db) {
    db = process.env.DATABASE_URL;
    if (!pool[db])
      pool[db] = anyDB.createPool(db, {min: 1, max: 5});
  }

  t.pool_key = db;

  return t;
};

T.return_rows_for = ['INSERT', 'SELECT', 'UPDATE', 'DELETE'];

T.run = function (topogo, q, vars, flow) {
  var args = _.toArray(arguments);
  if (args.length === 3) {
    topogo    = Topogo.new("unknown table");
    var q     = args[0];
    var vars  = args[1];
    var flow  = args[2];
  }

  if (!_.isArray(vars)) {
    var arr  = [];
    var i = 0;
    _.each(vars, function (v, name) {
      ++i;
      q = q.replace('@' + name, '$' + i);
      arr.push(v);
    });
    vars = arr;
  }

  pool[topogo.pool_key].query(q, vars, function (err, result) {
    if (err) {

      if (err.detail && topogo.on_dup) {
        if (err.detail.indexOf("Key (" + topogo.dup_name + ")=") > -1 &&
            err.detail.indexOf(") already exists") > 0)
          return topogo.on_dup(topogo.dup_name);

        if (err.detail.indexOf("duplicate key value violates unique constrait") > -1 &&
            err.detail.indexOf("_" + topogo.dup_name + '_') > 33)
          return topogo.on_dup(topogo.dup_name);
      }

      if (process.env.IS_TESTING || process.env.IS_DEV)
        console['log'](q);

      flow.finish('error', err);
    }

    if (_.contains(T.return_rows_for, result.command) && result.rows)
      flow.finish(result.rows);
    else
      flow.finish(result);
  });
};

T.prototype.toString = function () {
  return "Topogo (instance, table: " + this.table + ")";
};

T.prototype.delete_trashed = function (limit, flow) {
  if (arguments.length < 2) {
    flow = limit;
    limit = (new Date).getTime() - (1000 * 60 * 60 * 48);
  }

  var sql = "\
    DELETE FROM " + this.table + "   \
    WHERE trashed_at IS NOT NULL AND \
          trashed_at < $1            \
    RETURNING * ;                    \
  ";

  T.run(this, sql, [ limit ], flow.concat(function (rows) {
    flow.finish(rows);
  }));
  return this;
};

T.prototype.run = function (sql, vals, flow) {
  return T.run(this, sql.replace(/@table[^a-z0-9\_]/g, this.table), vals, flow);
};

T.show_tables = function () {
  var sql  = T.sql.select_tables
  , on_fin = null
  , flow   = null;

  _.each(arguments, function (v) {
    if (_.isString(v))
      sql += ' ' + v;
    else if (_.isFunction(v))
      on_fin = v;
    else
      flow = v;
  });

  var db = T.run(T.new('no table'), sql, [], {
    finish: function (rows, err) {
      var tables = _.pluck(rows, 'name');
      if (err)
        flow.finish('error', err);
      if (on_fin)
        return on_fin(tables);
      if (flow)
        return flow.finish(tables);
  }});

  return db;
};



// ****************************************************************
// ****************** CREATE **************************************
// ****************************************************************

T.prototype.create = function (data, flow) {
  var me = this;

  var cols = [], vals = [], places = [], i = 0;
  _.each(data, function (v, col) {
    cols.push(col);
    vals.push(v);
    ++i;
    places.push('$' + i);
  });

  var sql = "\
    INSERT INTO @table (@cols)   \
    VALUES (@vals)               \
    RETURNING * ;                \
  "
  .replace('@table', me.table)
  .replace('@cols', cols.join(', '))
  .replace('@vals', places.join(', '));

  T.run(me, sql, vals, flow.reply(function (j) {
    j.finish(j.result[0]);
  }));
};

T.prototype.create_index = function (data, flow) {
  var name = this.name;
  request.post({
    url  : T.url('/index?collection=' + name),
    json : true,
    body : data
  }, on_complete(flow));
};

T.prototype.create_collection = function (flow) {
  var name = this.name;
  request.post({
    url: T.url('/collection'),
    json: true,
    body: {
      name: name,
      waitForSync: true,
      journalSize: T.mb(4)
    }
  }, on_complete(flow));
};


// ****************************************************************
// ****************** READ ****************************************
// ****************************************************************

T.read_list = function (flow) {
  request.get({
    url: T.url("/collection"),
    json: true
  }, on_complete(flow));
};

T.prototype.read = function (id, flow) {
  var name = this.name;

  request.get({
    url: T.url("/document/" + name + '/' + id),
    json: true
  }, on_complete(flow));
};

T.prototype.read_by_id = function (id, flow) {
  return this.read_one_by_example({id: id}, flow);
};

T.prototype.read_one_by_example = function (doc, flow) {
  var me   = this;
  var vals = [];
  var sql  = "SELECT * FROM @table WHERE @vals LIMIT 1 ;"
  .replace('@table', me.table)
  .replace('@vals', doc_to_and(doc, vals));

  T.run(me, sql, vals, flow.concat(function (rows) {
    flow.finish(rows[0]);
  }));
};

T.prototype.read_list_by_example = function (doc, flow) {
  var me   = this;
  var vals = [];
  var sql  = "SELECT * FROM @table WHERE @vals ;"
  .replace('@table', me.table)
  .replace('@vals', doc_to_and(doc, vals));

  T.run(me, sql, vals, flow.concat(function (rows) {
    flow.finish(rows);
  }));
};

T.prototype.read_list_all_ids = function (flow) {
  var me = this;
  request.get({
    url: T.url("/document?collection=" + me.name),
    json: true
  }, on_complete(flow, function (data) {
      flow.finish(data.documents);
  }))
};

T.prototype.read_list_indexs = function (flow) {
  var me = this;
  request.get({
    url: T.url('/index?collection=' + me.name),
    json: true,
  }, on_complete(flow));
};

// ****************************************************************
// ****************** UPDATE **************************************
// ****************************************************************

T.prototype.update = function (where, set, flow) {

  if (_.isString(where) || _.isNumber(where))
    where = {id: where};

  var me = this;
  var sql_and_vals = doc_to_update_sql(set, where);
  var vals         = sql_and_vals.vals;
  var sql          = sql_and_vals.sql.replace('@table', me.table);

  T.run(me, sql, vals, flow.concat(function (rows) {
    if (where.id)
      flow.finish(rows[0]);
    else
      flow.finish(rows);
  }));
};

// ****************************************************************
// ****************** Trash/Untrash********************************
// ****************************************************************

T.prototype.untrash = function (id, flow) {
  var me = this;
  River.new(arguments)
  .job('update', function (j) {
    me.update(id, {trashed_at: null}, j);
  })
  .run();
};

T.prototype.trash = function (id, flow) {
  var me = this;
  var _now = now();
  River.new(arguments)
  .job('update', function (j) {
    me.update(id, {trashed_at: _now}, j);
  })
  .reply(function () {
    return _now;
  })
  .run();
};

// ****************************************************************
// ****************** DELETE **************************************
// ****************************************************************


T.prototype.del = function (id, flow) {
  var me = this;
  request.del({
    url: T.url("/document/" + me.name + '/' + id),
    json: true
  }, on_complete(flow, 'delete'));
};



// ****************************************************************
// ****************** OLD CODE ************************************
// ****************************************************************


T.rollback = function rollback(client, on_err) {
  return function (err, meta) {
    if (err) {
      client.query('ROLLBACK', [], function (new_err) {
        client.end();
        if (on_err)
          on_err(new_err || err);
        else
          throw (new_err || err);
      });
    };

  };
};














